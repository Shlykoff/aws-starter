import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/lib/config";

describe("loadConfig", () => {
  it("reads the table name and defaults the log level to info", () => {
    expect(loadConfig({ TABLE_NAME: "demo-dev-requests" })).toEqual({
      tableName: "demo-dev-requests",
      logLevel: "info",
    });
  });

  it("uses LOG_LEVEL when it is set", () => {
    expect(loadConfig({ TABLE_NAME: "t", LOG_LEVEL: "debug" }).logLevel).toBe("debug");
  });

  it("fails with a clear message when TABLE_NAME is missing", () => {
    expect(() => loadConfig({})).toThrow("Invalid configuration: TABLE_NAME is required");
  });

  it("fails when TABLE_NAME is empty", () => {
    expect(() => loadConfig({ TABLE_NAME: "" })).toThrow(/TABLE_NAME must not be empty/);
  });

  it("fails on a LOG_LEVEL it does not know instead of silently using the default", () => {
    expect(() => loadConfig({ TABLE_NAME: "t", LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });
});
