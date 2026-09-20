import { afterEach, describe, expect, it, vi } from "vitest";

describe("container", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("gives every caller the same service instance", async () => {
    const { container } = await import("../src/container");
    const { TOKENS } = await import("../src/tokens");
    const { RequestService } = await import("../src/services/request-service");

    const first = container.get(TOKENS.RequestService);
    const second = container.get(TOKENS.RequestService);

    expect(first).toBeInstanceOf(RequestService);
    expect(second).toBe(first);
  });

  it("fails fast at import when TABLE_NAME is missing, like a Lambda cold start would", async () => {
    vi.stubEnv("TABLE_NAME", undefined);
    vi.resetModules();

    await expect(import("../src/container")).rejects.toThrow(
      "Invalid configuration: TABLE_NAME is required",
    );
  });
});
