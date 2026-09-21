import { describe, expect, it } from "vitest";
import { DECISIONS } from "../../src/domain/client-decision";
import { EXCHANGE_OUTCOMES } from "../../src/domain/exchange";
import { REQUEST_STATUSES } from "../../src/domain/request";
import { LogGuardError, sanitizeFields } from "../../src/lib/log-fields";
import { createLogger } from "../../src/lib/logger";
import { logRequestEvent } from "../../src/lib/request-events";
import type { RequestEvent } from "../../src/lib/request-events";
import { withSpan } from "../../src/lib/tracing";
import { captureLogs } from "../helpers/logs";
import { recordSpans } from "../helpers/tracing";

const ID = "01M30JDSMHY8CRX59V35WV731S";

// One example of every event of the catalogue (docs/api.md, "Logs", "Request events").
const EXAMPLES: RequestEvent[] = [
  { event: "request_created", role: "user", requestId: ID, toStatus: "created" },
  { event: "request_queued", role: "enqueuer", requestId: ID, fromStatus: "created", toStatus: "queued" },
  { event: "delivery_attempted", role: "worker", requestId: ID, attempt: 2, outcome: "retry", httpStatus: 503, partnerMs: 120 },
  { event: "delivery_attempted", role: "worker", requestId: ID, attempt: 1, outcome: "unrepresentable" },
  { event: "request_sent", role: "worker", requestId: ID, toStatus: "sent", attempt: 1, sinceCreatedMs: 900 },
  { event: "request_rejected", role: "worker", requestId: ID, toStatus: "rejected", attempt: 1, sinceCreatedMs: 900 },
  { event: "request_failed", role: "worker", requestId: ID, toStatus: "failed", attempt: 5, sinceCreatedMs: 9000 },
  { event: "retry_requested", role: "user", requestId: ID, fromStatus: "failed", toStatus: "created", retryCount: 1 },
  { event: "decision_recorded", role: "recipient", requestId: ID, decision: "Declined" },
];

describe("logRequestEvent", () => {
  it("writes one info line: the fixed message, and the fields of the event flattened", () => {
    const logs = captureLogs();

    logRequestEvent(createLogger("info"), EXAMPLES[2] as RequestEvent);

    expect(logs.entries()).toEqual([
      {
        level: "info",
        message: "Request event",
        event: "delivery_attempted",
        role: "worker",
        requestId: ID,
        attempt: 2,
        outcome: "retry",
        httpStatus: 503,
        partnerMs: 120,
      },
    ]);
  });

  it("adds no trace id without an SDK: the line is exactly the fields of the event", () => {
    const logs = captureLogs();

    logRequestEvent(createLogger("info"), EXAMPLES[0] as RequestEvent);

    expect(Object.keys(logs.entries()[0] ?? {}).sort()).toEqual(["event", "level", "message", "requestId", "role", "toStatus"]);
  });

  it("leaves out an optional field that is not there", () => {
    const logs = captureLogs();

    logRequestEvent(createLogger("info"), { event: "delivery_attempted", role: "worker", requestId: ID, attempt: 1, outcome: "unrepresentable", httpStatus: undefined });

    expect(Object.keys(logs.entries()[0] ?? {})).not.toContain("httpStatus");
  });

  it.each(EXAMPLES.map((example) => [example.event, example] as const))(
    "%s passes the log guard (strict mode: a value the guard would change throws)",
    (_name, example) => {
      captureLogs();

      expect(() => logRequestEvent(createLogger("info", {}, { strict: true }), example)).not.toThrow();
    },
  );

  // These two are checked by `yarn typecheck`: an @ts-expect-error that has no error to expect fails it.
  it("does not compile with a misspelled event name (and the guard stops that at run time too)", () => {
    captureLogs();
    const log = createLogger("info", {}, { strict: true });

    // @ts-expect-error "request_queud" is not one of the events
    expect(() => logRequestEvent(log, { event: "request_queud", role: "enqueuer", requestId: ID })).toThrow(LogGuardError);
  });

  it("does not compile with the field of another event (the guard checks shapes, so at run time it is the type that protects)", () => {
    captureLogs();
    const log = createLogger("info", {}, { strict: true });

    // @ts-expect-error `retryCount` belongs to retry_requested, not to request_created
    logRequestEvent(log, { event: "request_created", role: "user", requestId: ID, toStatus: "created", retryCount: 1 });
  });
});

describe("the log guard: the fields of the request events", () => {
  const problemsOf = (fields: Record<string, unknown>) => sanitizeFields(fields).problems;

  it("event: exactly the eight names", () => {
    const names = ["request_created", "request_queued", "delivery_attempted", "request_sent", "request_rejected", "request_failed", "retry_requested", "decision_recorded"];
    for (const name of names) expect(problemsOf({ event: name }), name).toEqual([]);

    for (const other of ["request_created ", "Request_created", "request_deleted", "request created", "", 42]) {
      expect(sanitizeFields({ event: other }).fields.event, String(other)).toBe("[rejected]");
    }
  });

  it("role: the four roles", () => {
    for (const role of ["user", "enqueuer", "worker", "recipient"]) expect(problemsOf({ role })).toEqual([]);
    expect(sanitizeFields({ role: "admin" }).fields.role).toBe("[rejected]");
  });

  it("fromStatus and toStatus: the five statuses of a request", () => {
    for (const status of REQUEST_STATUSES) expect(problemsOf({ fromStatus: status, toStatus: status }), status).toEqual([]);
    expect(sanitizeFields({ toStatus: "done" }).fields.toStatus).toBe("[rejected]");
  });

  it.each(["attempt", "retryCount", "partnerMs", "sinceCreatedMs"])("%s: a finite number that is not negative", (name) => {
    for (const good of [0, 1, 250, 3_600_000]) expect(problemsOf({ [name]: good })).toEqual([]);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "5", null]) {
      expect(sanitizeFields({ [name]: bad }).fields[name], String(bad)).toBe("[rejected]");
    }
  });

  it("outcome takes the five outcomes of a delivery attempt and decision the two decisions, as they are", () => {
    for (const outcome of EXCHANGE_OUTCOMES) expect(problemsOf({ outcome }), outcome).toEqual([]);
    for (const decision of DECISIONS) expect(problemsOf({ decision }), decision).toEqual([]);
  });
});

describe("logRequestEvent inside a span", () => {
  const spans = recordSpans();

  it("adds the trace id of the active span, so the timeline of a request can jump to the trace", async () => {
    const logs = captureLogs();

    await withSpan("invocation", {}, () => {
      logRequestEvent(createLogger("info", {}, { strict: true }), EXAMPLES[0] as RequestEvent);
    });

    const traceId = spans.only("invocation").spanContext().traceId;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(logs.entries()).toEqual([
      { level: "info", message: "Request event", event: "request_created", role: "user", requestId: ID, toStatus: "created", traceId },
    ]);
  });
});

describe("the log guard: traceId", () => {
  it("takes 32 lower-case hex digits and nothing else", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

    expect(sanitizeFields({ traceId }).problems).toEqual([]);
    for (const bad of [traceId.toUpperCase(), traceId.slice(1), `${traceId}0`, `${traceId.slice(0, 31)}g`, "", `${traceId} `, 42, null, [traceId]]) {
      expect(sanitizeFields({ traceId: bad }).fields.traceId, String(bad)).toBe("[rejected]");
    }
  });
});
