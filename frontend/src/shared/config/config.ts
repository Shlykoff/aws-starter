import { z } from "zod";

// The five values the app needs at startup, all public identifiers (see .env.example).
// Vite only exposes variables that start with VITE_ to the browser bundle.
const envSchema = z.object({
  VITE_AWS_REGION: z.string().trim().min(1, "is empty"),
  VITE_COGNITO_USER_POOL_ID: z.string().trim().min(1, "is empty"),
  VITE_COGNITO_CLIENT_ID: z.string().trim().min(1, "is empty"),
  VITE_COGNITO_HOSTED_UI_URL: z.httpUrl("must be an http(s) URL"),
  VITE_API_URL: z.httpUrl("must be an http(s) URL"),
});

export interface AppConfig {
  region: string;
  userPoolId: string;
  clientId: string;
  // Both URLs are stored without a trailing slash, so callers can append "/path".
  hostedUiUrl: string;
  apiUrl: string;
}

export interface ConfigProblem {
  name: string;
  message: string;
}

export type ConfigResult =
  | { ok: true; config: AppConfig }
  | { ok: false; problems: ConfigProblem[] };

const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, "");

// Takes the raw env object (import.meta.env) as a parameter so tests can pass their own.
export function parseConfig(env: Record<string, unknown>): ConfigResult {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => ({
        name: String(issue.path[0]),
        // A variable that is not set at all is `undefined`, which zod reports as a type
        // error; say "is missing" instead of zod's technical message.
        message: issue.code === "invalid_type" ? "is missing" : issue.message,
      })),
    };
  }

  const values = parsed.data;
  return {
    ok: true,
    config: {
      region: values.VITE_AWS_REGION,
      userPoolId: values.VITE_COGNITO_USER_POOL_ID,
      clientId: values.VITE_COGNITO_CLIENT_ID,
      hostedUiUrl: withoutTrailingSlash(values.VITE_COGNITO_HOSTED_UI_URL),
      apiUrl: withoutTrailingSlash(values.VITE_API_URL),
    },
  };
}

export function loadConfig(): ConfigResult {
  return parseConfig(import.meta.env);
}
