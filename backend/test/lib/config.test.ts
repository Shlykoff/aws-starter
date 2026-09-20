import { describe, expect, it } from "vitest";
import {
  loadConfig,
  loadEnqueuerConfig,
  loadMockConfig,
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

describe("loadWorkerConfig", () => {
  const env = {
    TABLE_NAME: "t",
    PARTNER_URL: "https://abc.lambda-url.eu-north-1.on.aws/",
    TOPIC_ARN: "arn:aws:sns:eu-north-1:000000000000:status",
    AUDIT_BUCKET: "audit",
    MAX_RECEIVE_COUNT: "5",
    AWS_REGION: "eu-north-1",
  };

  it("reads all variables and turns MAX_RECEIVE_COUNT into a number", () => {
    expect(loadWorkerConfig(env)).toEqual({
      tableName: "t",
      partnerUrl: "https://abc.lambda-url.eu-north-1.on.aws/",
      topicArn: "arn:aws:sns:eu-north-1:000000000000:status",
      auditBucket: "audit",
      maxReceiveCount: 5,
      region: "eu-north-1",
      logLevel: "info",
    });
  });

  it.each(["0", "-3", "2.5", "five", " 5", "5 "])("rejects MAX_RECEIVE_COUNT=%j", (value) => {
    expect(() => loadWorkerConfig({ ...env, MAX_RECEIVE_COUNT: value })).toThrow(
      "MAX_RECEIVE_COUNT must be a positive integer",
    );
  });

  it.each(["TABLE_NAME", "PARTNER_URL", "TOPIC_ARN", "AUDIT_BUCKET", "MAX_RECEIVE_COUNT", "AWS_REGION"])(
    "fails when %s is missing",
    (name) => {
      const without = Object.fromEntries(Object.entries(env).filter(([key]) => key !== name));
      expect(() => loadWorkerConfig(without)).toThrow(`${name} is required`);
    },
  );
});

describe("loadMockConfig", () => {
  it("needs nothing and defaults the log level to info", () => {
    expect(loadMockConfig({})).toEqual({ logLevel: "info" });
  });

  it("uses LOG_LEVEL when it is set", () => {
    expect(loadMockConfig({ LOG_LEVEL: "warn" })).toEqual({ logLevel: "warn" });
  });
});
