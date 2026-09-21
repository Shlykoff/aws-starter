import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every function has its own container file (see src/container-shared.ts). These tests check
// that each one starts with exactly the variables of its own row in docs/api.md: it fails
// fast when one of them is missing, and it does not care about the variables of the others.
// The baseline (all variables set) comes from vitest.config.ts.

// The worker reads the XSD files from `schemas/` next to its bundle, which does not exist
// next to the sources. These tests read them from contracts/xsd/ itself. The module that
// names the folder is replaced ONCE, by a getter that reads `schemas.directory`, so a test
// can change the folder by assigning to it. (Registering a mock again for the same module
// inside a test is not safe: two registrations that are still pending can be applied in
// either order.)
const schemas = vi.hoisted(() => ({ directory: undefined as URL | undefined }));
vi.mock("../src/lib/schemas-location", () => ({
  get SCHEMAS_DIRECTORY() {
    return schemas.directory;
  },
}));
const XSD_DIRECTORY = new URL("../../contracts/xsd/", import.meta.url);
beforeEach(() => {
  schemas.directory = XSD_DIRECTORY;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const unset = (...names: string[]) => {
  for (const name of names) vi.stubEnv(name, undefined);
  vi.resetModules();
};

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
    unset("PARTNER_URL", "PARTNER_API_KEY_PARAM", "TOPIC_ARN", "AUDIT_BUCKET", "MAX_RECEIVE_COUNT");

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

  it("shares one API key provider, so that its cache serves every message", async () => {
    const { container } = await import("../src/container-worker");
    const { TOKENS } = await import("../src/tokens");

    expect(container.get(TOKENS.ApiKeyProvider)).toBe(container.get(TOKENS.ApiKeyProvider));
  });

  it.each(["TABLE_NAME", "PARTNER_URL", "PARTNER_API_KEY_PARAM", "TOPIC_ARN", "AUDIT_BUCKET", "MAX_RECEIVE_COUNT"])(
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

  it.each(["partner", "http://partner.example.com", "https://partner.example.com/v1"])(
    "fails fast when PARTNER_URL is %j, not an https address of host and port only",
    async (value) => {
      vi.stubEnv("PARTNER_URL", value);
      vi.resetModules();

      await expect(import("../src/container-worker")).rejects.toThrow(/PARTNER_URL must be an https URL/);
    },
  );

  it("fails fast when SENDER_NAME is a name the recipient's schema would refuse", async () => {
    vi.stubEnv("SENDER_NAME", "Acme #1");
    vi.resetModules();

    await expect(import("../src/container-worker")).rejects.toThrow(/SENDER_NAME must be 1-100 letters/);
  });

  it("names every missing variable at once", async () => {
    unset("TABLE_NAME", "PARTNER_URL", "PARTNER_API_KEY_PARAM", "TOPIC_ARN", "AUDIT_BUCKET", "MAX_RECEIVE_COUNT");

    await expect(import("../src/container-worker")).rejects.toThrow(
      "Invalid configuration: TABLE_NAME is required; PARTNER_URL is required; PARTNER_API_KEY_PARAM is required; TOPIC_ARN is required; AUDIT_BUCKET is required; MAX_RECEIVE_COUNT is required",
    );
  });

  it("does not need QUEUE_URL", async () => {
    unset("QUEUE_URL");

    await expect(import("../src/container-worker")).resolves.toBeDefined();
  });

  it("fails while it starts when the schema files are not there (a package without its schemas)", async () => {
    schemas.directory = new URL("file:///no/such/folder/");
    vi.resetModules();

    const { container } = await import("../src/container-worker");
    const { TOKENS } = await import("../src/tokens");

    expect(() => container.get(TOKENS.DeliveryService)).toThrow(/ENOENT/);
  });
});

describe("get-exchange container", () => {
  it("builds one service and shares it", async () => {
    const { container } = await import("../src/container-exchange");
    const { TOKENS } = await import("../src/tokens");
    const { ExchangeService } = await import("../src/services/exchange-service");

    const service = container.get(TOKENS.ExchangeService);

    expect(service).toBeInstanceOf(ExchangeService);
    expect(container.get(TOKENS.ExchangeService)).toBe(service);
  });

  it.each(["TABLE_NAME", "AUDIT_BUCKET"])("fails fast when %s is missing", async (name) => {
    unset(name);

    await expect(import("../src/container-exchange")).rejects.toThrow(`Invalid configuration: ${name} is required`);
  });

  it("does not need the variables of the other functions", async () => {
    unset("QUEUE_URL", "PARTNER_URL", "PARTNER_API_KEY_PARAM", "TOPIC_ARN", "MAX_RECEIVE_COUNT");

    await expect(import("../src/container-exchange")).resolves.toBeDefined();
  });
});

describe("API container", () => {
  it("does not need the variables of the delivery pipeline", async () => {
    unset("QUEUE_URL", "PARTNER_URL", "PARTNER_API_KEY_PARAM", "TOPIC_ARN", "AUDIT_BUCKET", "MAX_RECEIVE_COUNT");

    await expect(import("../src/container")).resolves.toBeDefined();
  });
});
