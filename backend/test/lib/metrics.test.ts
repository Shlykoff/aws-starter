import { afterEach, describe, expect, it, vi } from "vitest";
import { recordMetric } from "../../src/lib/metrics";
import { logRequestEvent } from "../../src/lib/request-events";
import { createLogger } from "../../src/lib/logger";

const NAMESPACE = "aws-starter/test";

function spyOnConsole() {
  const lines: string[] = [];
  for (const method of ["debug", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
  }
  return lines;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("recordMetric", () => {
  it("writes one EMF line: the namespace, one metric with its unit, no dimensions, the value", () => {
    vi.stubEnv("METRICS_NAMESPACE", NAMESPACE);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-21T12:00:00.000Z"));
    const lines = spyOnConsole();

    recordMetric("TimeToSentMs", 5005);
    vi.useRealTimers();

    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        _aws: {
          Timestamp: Date.parse("2026-09-21T12:00:00.000Z"),
          CloudWatchMetrics: [{ Namespace: NAMESPACE, Dimensions: [[]], Metrics: [{ Name: "TimeToSentMs", Unit: "Milliseconds" }] }],
        },
        TimeToSentMs: 5005,
      },
    ]);
  });

  it("does nothing without a namespace (the tests, a local run)", () => {
    const lines = spyOnConsole();

    recordMetric("PartnerMs", 100);

    expect(lines).toEqual([]);
  });

  it.each(["", "has space", "x".repeat(256), "with\nnewline", "quote\""])("does nothing for the namespace %j", (namespace) => {
    vi.stubEnv("METRICS_NAMESPACE", namespace);
    const lines = spyOnConsole();

    recordMetric("PartnerMs", 100);

    expect(lines).toEqual([]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("does nothing for the value %s: a metric must never break a handler", (value) => {
    vi.stubEnv("METRICS_NAMESPACE", NAMESPACE);
    const lines = spyOnConsole();

    expect(() => recordMetric("PartnerMs", value)).not.toThrow();

    expect(lines).toEqual([]);
  });

  it("accepts 0", () => {
    vi.stubEnv("METRICS_NAMESPACE", NAMESPACE);
    const lines = spyOnConsole();

    recordMetric("PartnerMs", 0);

    expect(lines).toHaveLength(1);
  });
});

describe("the request events publish their durations", () => {
  const ID = "01M32E9TP716ZE553TCXK5H5CC";

  it("request_sent publishes TimeToSentMs, delivery_attempted publishes PartnerMs, once each", () => {
    vi.stubEnv("METRICS_NAMESPACE", NAMESPACE);
    const lines = spyOnConsole();
    const log = createLogger("info");

    logRequestEvent(log, { event: "delivery_attempted", role: "worker", requestId: ID, attempt: 1, outcome: "delivered", httpStatus: 200, partnerMs: 385 });
    logRequestEvent(log, { event: "request_sent", role: "worker", requestId: ID, toStatus: "sent", attempt: 1, sinceCreatedMs: 5005 });

    const metrics = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => "_aws" in entry);
    expect(metrics.map((entry) => [entry.PartnerMs, entry.TimeToSentMs])).toEqual([[385, undefined], [undefined, 5005]]);
  });

  it("publishes nothing for the other events, or for an attempt that did not call the recipient", () => {
    vi.stubEnv("METRICS_NAMESPACE", NAMESPACE);
    const lines = spyOnConsole();
    const log = createLogger("info");

    logRequestEvent(log, { event: "request_created", role: "user", requestId: ID, toStatus: "created" });
    logRequestEvent(log, { event: "delivery_attempted", role: "worker", requestId: ID, attempt: 1, outcome: "invalid_request" });
    logRequestEvent(log, { event: "request_failed", role: "worker", requestId: ID, toStatus: "failed", attempt: 5, sinceCreatedMs: 480000 });

    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => "_aws" in entry)).toEqual([]);
  });
});
