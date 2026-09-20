import { describe, expect, it } from "vitest";
import { parseConfig } from "./config";

const validEnv = {
  VITE_AWS_REGION: "eu-north-1",
  VITE_COGNITO_USER_POOL_ID: "eu-north-1_EXAMPLE",
  VITE_COGNITO_CLIENT_ID: "example-client-id",
  VITE_COGNITO_HOSTED_UI_URL: "https://example.auth.eu-north-1.amazoncognito.com",
  VITE_API_URL: "https://api.example.com",
};

describe("parseConfig", () => {
  it("maps the environment variables to the config object", () => {
    expect(parseConfig(validEnv)).toEqual({
      ok: true,
      config: {
        region: "eu-north-1",
        userPoolId: "eu-north-1_EXAMPLE",
        clientId: "example-client-id",
        hostedUiUrl: "https://example.auth.eu-north-1.amazoncognito.com",
        apiUrl: "https://api.example.com",
      },
    });
  });

  it("strips trailing slashes from both URLs", () => {
    const result = parseConfig({
      ...validEnv,
      VITE_API_URL: "https://api.example.com/",
      VITE_COGNITO_HOSTED_UI_URL: "https://example.auth.eu-north-1.amazoncognito.com//",
    });

    expect(result).toMatchObject({
      ok: true,
      config: { apiUrl: "https://api.example.com", hostedUiUrl: "https://example.auth.eu-north-1.amazoncognito.com" },
    });
  });

  it("lists every missing variable by name", () => {
    const missing = ["VITE_COGNITO_CLIENT_ID", "VITE_API_URL"];
    const env = Object.fromEntries(Object.entries(validEnv).filter(([name]) => !missing.includes(name)));

    const result = parseConfig(env);

    expect(result).toEqual({
      ok: false,
      problems: [
        { name: "VITE_COGNITO_CLIENT_ID", message: "is missing" },
        { name: "VITE_API_URL", message: "is missing" },
      ],
    });
  });

  it("reports empty values and values that are not URLs", () => {
    const result = parseConfig({ ...validEnv, VITE_AWS_REGION: "  ", VITE_API_URL: "not a url" });

    expect(result).toEqual({
      ok: false,
      problems: [
        { name: "VITE_AWS_REGION", message: "is empty" },
        { name: "VITE_API_URL", message: "must be an http(s) URL" },
      ],
    });
  });
});
