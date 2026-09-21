import { describe, expect, it } from "vitest";
import {
  loadArchiverConfig,
  loadConfig,
  loadEnqueuerConfig,
  loadExchangeConfig,
  loadWebhookConfig,
  loadWorkerConfig,
} from "../../src/lib/config";

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

describe("loadEnqueuerConfig", () => {
  const env = { TABLE_NAME: "t", QUEUE_URL: "https://sqs.eu-north-1.amazonaws.com/000000000000/q.fifo" };

  it("reads the table name and the queue URL", () => {
    expect(loadEnqueuerConfig(env)).toEqual({ tableName: "t", queueUrl: env.QUEUE_URL, logLevel: "info" });
  });

  it("names every missing variable", () => {
    expect(() => loadEnqueuerConfig({})).toThrow(
      "Invalid configuration: TABLE_NAME is required; QUEUE_URL is required",
    );
  });

  it("does not ask for the variables of the API or of the worker", () => {
    expect(() => loadEnqueuerConfig(env)).not.toThrow();
  });
});

describe("loadExchangeConfig", () => {
  const env = { TABLE_NAME: "t", AUDIT_BUCKET: "demo-dev-deliveries-000000000000" };

  it("reads the table and the bucket, and defaults the log level to info", () => {
    expect(loadExchangeConfig(env)).toEqual({
      tableName: "t",
      auditBucket: "demo-dev-deliveries-000000000000",
      logLevel: "info",
    });
  });

  it("uses LOG_LEVEL when it is set", () => {
    expect(loadExchangeConfig({ ...env, LOG_LEVEL: "debug" }).logLevel).toBe("debug");
  });

  it("names every missing variable", () => {
    expect(() => loadExchangeConfig({})).toThrow(
      "Invalid configuration: TABLE_NAME is required; AUDIT_BUCKET is required",
    );
  });

  it("does not ask for the variables of the worker", () => {
    expect(() => loadExchangeConfig(env)).not.toThrow();
  });
});

describe("loadWorkerConfig", () => {
  const env = {
    TABLE_NAME: "t",
    PARTNER_URL: "https://partner.example.com",
    PARTNER_API_KEY_PARAM: "/demo/dev/partner-api-key",
    TOPIC_ARN: "arn:aws:sns:eu-north-1:000000000000:status",
    AUDIT_BUCKET: "audit",
    MAX_RECEIVE_COUNT: "5",
  };

  it("reads all variables, defaults the sender name, and turns MAX_RECEIVE_COUNT into a number", () => {
    expect(loadWorkerConfig(env)).toEqual({
      tableName: "t",
      partnerUrl: "https://partner.example.com",
      partnerApiKeyParam: "/demo/dev/partner-api-key",
      senderName: "aws-starter",
      topicArn: "arn:aws:sns:eu-north-1:000000000000:status",
      auditBucket: "audit",
      maxReceiveCount: 5,
      logLevel: "info",
    });
  });

  it("does not need AWS_REGION any more (nothing is signed by hand)", () => {
    expect(() => loadWorkerConfig(env)).not.toThrow();
  });

  it.each(["0", "-3", "2.5", "five", " 5", "5 "])("rejects MAX_RECEIVE_COUNT=%j", (value) => {
    expect(() => loadWorkerConfig({ ...env, MAX_RECEIVE_COUNT: value })).toThrow(
      "MAX_RECEIVE_COUNT must be a positive integer",
    );
  });

  it.each(["TABLE_NAME", "PARTNER_URL", "PARTNER_API_KEY_PARAM", "TOPIC_ARN", "AUDIT_BUCKET", "MAX_RECEIVE_COUNT"])(
    "fails when %s is missing",
    (name) => {
      const without = Object.fromEntries(Object.entries(env).filter(([key]) => key !== name));
      expect(() => loadWorkerConfig(without)).toThrow(`${name} is required`);
    },
  );

  describe("PARTNER_URL: the address of the recipient", () => {
    it.each([
      "https://partner.example.com",
      "https://partner.example.com/", // the slash after the host is the empty path, not a path
      "https://partner.example.com:8443",
      "https://abc-123.ngrok-free.app",
      "http://localhost:8080", // plain http: this computer only
      "http://127.0.0.1:8080",
      "http://[::1]:8080",
      "https://localhost:8443",
    ])("accepts %s", (value) => {
      expect(loadWorkerConfig({ ...env, PARTNER_URL: value }).partnerUrl).toBe(value);
    });

    it.each([
      ["a plain http host on the internet: the API key would travel unencrypted", "http://partner.example.com"],
      ["http on a name that only starts like localhost", "http://localhost.evil.example"],
      ["http on a private address (only loopback counts as this computer)", "http://192.168.1.10:8080"],
      ["a path", "https://partner.example.com/v1"],
      ["a path that is only a slash and more", "https://partner.example.com//"],
      ["a query", "https://partner.example.com?x=1"],
      ["an empty query", "https://partner.example.com?"],
      ["a fragment", "https://partner.example.com#x"],
      ["credentials", "https://user:password@partner.example.com"],
      ["a user name only", "https://user@partner.example.com"],
      ["another scheme", "ftp://partner.example.com"],
      ["no scheme", "partner.example.com"],
      ["text that is not a URL", "not a url"],
      ["an empty value", ""],
    ])("rejects %s", (_label, value) => {
      expect(() => loadWorkerConfig({ ...env, PARTNER_URL: value })).toThrow(/PARTNER_URL/);
    });

    it("does not print the URL back in the message: it may hold credentials", () => {
      let message = "";
      try {
        loadWorkerConfig({ ...env, PARTNER_URL: "https://user:hunter2@partner.example.com" });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain("PARTNER_URL must be an https URL");
      expect(message).not.toContain("hunter2");
    });
  });

  describe("SENDER_NAME: the name in every submission", () => {
    it("is used when it is set", () => {
      expect(loadWorkerConfig({ ...env, SENDER_NAME: "Acme Sender, Inc." }).senderName).toBe("Acme Sender, Inc.");
    });

    it.each(["Smith & Sons", "Ünïcode Näme", "Отправитель", "a", "x".repeat(100), "it's-me.co"])("accepts %j", (value) => {
      expect(loadWorkerConfig({ ...env, SENDER_NAME: value }).senderName).toBe(value);
    });

    // The rule is the PartyName type of contracts/xsd/common-types.xsd: the recipient would
    // refuse every submission that carries a name outside it.
    it.each([
      ["a character the schema forbids", "Acme #1"],
      ["markup", "<b>Acme</b>"],
      ["a line break", "Acme\nSender"],
      ["an empty name", ""],
      ["101 characters", "x".repeat(101)],
    ])("rejects %s", (_label, value) => {
      expect(() => loadWorkerConfig({ ...env, SENDER_NAME: value })).toThrow(/SENDER_NAME must be 1-100 letters/);
    });
  });
});

describe("loadWebhookConfig", () => {
  const env = { TABLE_NAME: "t", WEBHOOK_TOKEN_PARAM: "/dev/demo/webhook-token" };

  it("reads the table and the name of the token parameter, and defaults the log level to info", () => {
    expect(loadWebhookConfig(env)).toEqual({
      tableName: "t",
      webhookTokenParam: "/dev/demo/webhook-token",
      logLevel: "info",
    });
  });

  it("uses LOG_LEVEL when it is set", () => {
    expect(loadWebhookConfig({ ...env, LOG_LEVEL: "debug" }).logLevel).toBe("debug");
  });

  it("names every missing variable", () => {
    expect(() => loadWebhookConfig({})).toThrow(
      "Invalid configuration: TABLE_NAME is required; WEBHOOK_TOKEN_PARAM is required",
    );
  });

  it("does not accept an empty parameter name", () => {
    expect(() => loadWebhookConfig({ ...env, WEBHOOK_TOKEN_PARAM: "" })).toThrow(/WEBHOOK_TOKEN_PARAM must not be empty/);
  });

  it("does not ask for the variables of the other functions", () => {
    expect(() => loadWebhookConfig(env)).not.toThrow();
  });
});

describe("loadArchiverConfig", () => {
  it("reads the bucket and defaults the log level to info", () => {
    expect(loadArchiverConfig({ ARCHIVE_BUCKET: "demo-dev-log-archive" })).toEqual({
      archiveBucket: "demo-dev-log-archive",
      logLevel: "info",
    });
  });

  it("uses LOG_LEVEL when it is set", () => {
    expect(loadArchiverConfig({ ARCHIVE_BUCKET: "b", LOG_LEVEL: "warn" }).logLevel).toBe("warn");
  });

  it("fails with a clear message when ARCHIVE_BUCKET is missing", () => {
    expect(() => loadArchiverConfig({})).toThrow("Invalid configuration: ARCHIVE_BUCKET is required");
  });

  it("fails when ARCHIVE_BUCKET is empty", () => {
    expect(() => loadArchiverConfig({ ARCHIVE_BUCKET: "" })).toThrow(/ARCHIVE_BUCKET must not be empty/);
  });

  it("does not ask for the variables of the other functions", () => {
    expect(() => loadArchiverConfig({ ARCHIVE_BUCKET: "b" })).not.toThrow();
  });
});
