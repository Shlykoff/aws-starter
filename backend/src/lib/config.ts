import { z } from "zod";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  tableName: string;
  logLevel: LogLevel;
}

// The environment variables of the Lambda contract in docs/api.md.
const environmentSchema = z.object({
  TABLE_NAME: z
    .string({ error: "is required" })
    .min(1, "must not be empty"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
});

/**
 * Reads and validates the configuration. It throws with a readable message when something
 * is wrong. It is called once at cold start (src/container.ts), so a misconfigured function
 * fails while it initialises, not on the first customer request.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = environmentSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".")} ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return { tableName: result.data.TABLE_NAME, logLevel: result.data.LOG_LEVEL };
}
