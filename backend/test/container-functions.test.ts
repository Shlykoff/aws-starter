import { afterEach, describe, expect, it, vi } from "vitest";

// Every function has its own container file (see src/container-shared.ts). These tests check
// that each one starts with exactly the variables of its own row in docs/api.md: it fails
// fast when one of them is missing, and it does not care about the variables of the others.
// The baseline (all variables set) comes from vitest.config.ts.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const unset = (...names: string[]) => {
  for (const name of names) vi.stubEnv(name, undefined);
  vi.resetModules();
};

const ALL_VARIABLES = [
  "TABLE_NAME",
  "QUEUE_URL",
  "PARTNER_URL",
  "TOPIC_ARN",
  "AUDIT_BUCKET",
  "MAX_RECEIVE_COUNT",
  "LOG_LEVEL",
];

describe("enqueuer container", () => {
  it("builds one service and shares it", async () => {
    const { container } = await import("../src/container-enqueuer");
    const { TOKENS } = await import("../src/tokens");
    const { EnqueueService } = await import("../src/services/enqueue-service");

    const service = container.get(TOKENS.EnqueueService);

    expect(service).toBeInstanceOf(EnqueueService);
    expect(container.get(TOKENS.EnqueueService)).toBe(service);
  });

  it.each(["TABLE_NAME", "QUEUE_URL"])("fails fast when %s is missing", async (name) => {
    unset(name);

    await expect(import("../src/container-enqueuer")).rejects.toThrow(
      `Invalid configuration: ${name} is required`,
    );
  });

  it("fails fast when QUEUE_URL is not a URL", async () => {
    vi.stubEnv("QUEUE_URL", "not a url");
    vi.resetModules();

    await expect(import("../src/container-enqueuer")).rejects.toThrow(/QUEUE_URL must be a valid URL/);
  });

  it("does not need the variables of the other functions", async () => {
    unset("PARTNER_URL", "TOPIC_ARN", "AUDIT_BUCKET", "MAX_RECEIVE_COUNT");

    await expect(import("../src/container-enqueuer")).resolves.toBeDefined();
  });
});

describe("delivery-worker container", () => {
  it("builds one service and shares it", async () => {
    const { container } = await import("../src/container-worker");
    const { TOKENS } = await import("../src/tokens");
    const { DeliveryService } = await import("../src/services/delivery-service");

    const service = container.get(TOKENS.DeliveryService);

    expect(service).toBeInstanceOf(DeliveryService);
    expect(container.get(TOKENS.DeliveryService)).toBe(service);
  });

  it.each(["TABLE_NAME", "PARTNER_URL", "TOPIC_ARN", "AUDIT_BUCKET", "MAX_RECEIVE_COUNT"])(
    "fails fast when %s is missing",
    async (name) => {
      unset(name);

      await expect(import("../src/container-worker")).rejects.toThrow(
        `Invalid configuration: ${name} is required`,
      );
    },
  );

  it.each(["0", "-1", "2.5", "abc", "", "05", "1e3"])(
    "fails fast when MAX_RECEIVE_COUNT is %j, not a positive integer",
    async (value) => {
      vi.stubEnv("MAX_RECEIVE_COUNT", value);
      vi.resetModules();

      await expect(import("../src/container-worker")).rejects.toThrow(
        /MAX_RECEIVE_COUNT must be a positive integer/,
      );
    },
  );

  it("fails fast when PARTNER_URL is not a URL", async () => {
    vi.stubEnv("PARTNER_URL", "partner");
    vi.resetModules();

    await expect(import("../src/container-worker")).rejects.toThrow(/PARTNER_URL must be a valid URL/);
  });

  it("names every missing variable at once", async () => {
    unset("TABLE_NAME", "PARTNER_URL", "TOPIC_ARN", "AUDIT_BUCKET", "MAX_RECEIVE_COUNT");

    await expect(import("../src/container-worker")).rejects.toThrow(
      "Invalid configuration: TABLE_NAME is required; PARTNER_URL is required; TOPIC_ARN is required; AUDIT_BUCKET is required; MAX_RECEIVE_COUNT is required",
    );
  });

  it("does not need QUEUE_URL", async () => {
    unset("QUEUE_URL");

    await expect(import("../src/container-worker")).resolves.toBeDefined();
  });
});

describe("partner-mock container", () => {
  it("needs no environment variable at all", async () => {
    unset(...ALL_VARIABLES);

    const { container } = await import("../src/container-mock");
    const { TOKENS } = await import("../src/tokens");

    expect(container.get(TOKENS.Logger)).toBeDefined();
  });

  it("still rejects an unknown LOG_LEVEL", async () => {
    vi.stubEnv("LOG_LEVEL", "verbose");
    vi.resetModules();

    await expect(import("../src/container-mock")).rejects.toThrow(/LOG_LEVEL/);
  });
});

describe("API container", () => {
  it("does not need the variables of the delivery pipeline", async () => {
    unset("QUEUE_URL", "PARTNER_URL", "TOPIC_ARN", "AUDIT_BUCKET", "MAX_RECEIVE_COUNT");

    await expect(import("../src/container")).resolves.toBeDefined();
  });
});
