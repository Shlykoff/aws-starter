import { describe, expect, it } from "vitest";
import type { StoredClientDecision } from "../../src/domain/client-decision";
import type { DecisionRepository, RecordOutcome, RecordResult } from "../../src/repositories/decision-repository";
import type { SecretProvider } from "../../src/repositories/secret-provider";
import { MAX_BODY_BYTES, WebhookService } from "../../src/services/webhook-service";
import type { WebhookCall } from "../../src/services/webhook-service";
import { FakeXmlValidator } from "../helpers/fakes";
import type { Journal } from "../helpers/fakes";
import { captureLogs } from "../helpers/logs";
import { STORED_SPAN_ID, STORED_TRACEPARENT, STORED_TRACE_ID, parentIdOf, recordSpans, wholeSpan } from "../helpers/tracing";
import { NOW_SECONDS, REQUEST_ID, WEBHOOK_TOKEN, eventXml, sign } from "../helpers/webhook";
import { createLogger } from "../../src/lib/logger";

// The service with fake ports, to check WHAT is called and in WHICH ORDER: nothing expensive
// (the token in SSM, the XSD validator, the table) may happen before the checks that come
// first in contracts/webhook-api.md. The real validator and the real table are in
// test/handlers/receive-webhook.test.ts.

class FakeSecret implements SecretProvider {
  failWith: Error | undefined;
  constructor(private readonly journal: Journal) {}
  get(): Promise<string> {
    this.journal.push("secret.get");
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve(WEBHOOK_TOKEN);
  }
}

class FakeDecisions implements DecisionRepository {
  readonly recorded: { requestId: string; decision: StoredClientDecision; occurredAtMs: number }[] = [];
  outcome: RecordOutcome = "applied";
  /** The trace stored with the request, as the repository would hand it back. */
  traceparent: string | undefined;
  failWith: Error | undefined;
  constructor(private readonly journal: Journal) {}
  recordDecision(requestId: string, decision: StoredClientDecision, occurredAtMs: number): Promise<RecordResult> {
    this.journal.push("decisions.record");
    if (this.failWith) return Promise.reject(this.failWith);
    this.recorded.push({ requestId, decision, occurredAtMs });
    return Promise.resolve({ outcome: this.outcome, ...(this.traceparent !== undefined && { traceparent: this.traceparent }) });
  }
}

const NOW = new Date(NOW_SECONDS * 1000);

function setup() {
  const journal: Journal = [];
  const secret = new FakeSecret(journal);
  const validator = new FakeXmlValidator(journal);
  const decisions = new FakeDecisions(journal);
  const logs = captureLogs();
  const service = new WebhookService(secret, validator, decisions, () => NOW);
  const receive = (call: WebhookCall) => service.receive(call, createLogger("debug"));
  return { journal, secret, validator, decisions, logs, receive };
}

// A correctly signed call, with any part replaced.
function call(change: Partial<WebhookCall> & { timestamp?: string; token?: string } = {}): WebhookCall {
  const body = change.body ?? Buffer.from(eventXml({ reason: "Out of stock" }));
  const timestamp = change.timestamp ?? String(NOW_SECONDS);
  return {
    body,
    timestampHeader: "timestampHeader" in change ? change.timestampHeader : timestamp,
    signatureHeader: "signatureHeader" in change ? change.signatureHeader : sign(change.token ?? WEBHOOK_TOKEN, timestamp, body),
    contentType: "contentType" in change ? change.contentType : "application/xml",
  };
}

describe("WebhookService: the order of the checks", () => {
  it("refuses an oversized body first, before it looks at the signature", async () => {
    const { journal, receive } = setup();

    const outcome = await receive({ ...call(), body: Buffer.alloc(MAX_BODY_BYTES + 1), signatureHeader: "junk", contentType: "text/plain" });

    expect(outcome).toBe("too_large");
    expect(journal).toEqual([]);
  });

  it("counts the size in bytes: exactly 65 536 pass this check", async () => {
    const { receive } = setup();

    // (It fails the next check instead, the signature: that is the point.)
    expect(await receive({ ...call(), body: Buffer.alloc(MAX_BODY_BYTES), signatureHeader: "junk" })).toBe("unauthorized");
  });

  it.each([
    ["no timestamp", { timestampHeader: undefined }],
    ["a timestamp that is not digits", { timestampHeader: "yesterday" }],
    ["a stale timestamp", { timestampHeader: String(NOW_SECONDS - 301) }],
    ["no signature", { signatureHeader: undefined }],
    ["a malformed signature", { signatureHeader: "v1=xyz" }],
  ])("does not read the token, and does nothing else, for %s", async (_label, change) => {
    const { journal, receive } = setup();

    expect(await receive({ ...call(), ...change })).toBe("unauthorized");

    expect(journal).toEqual([]);
  });

  it("reads the token, and nothing after it, for a signature that is not the right one", async () => {
    const { journal, receive } = setup();

    expect(await receive(call({ token: "another-token" }))).toBe("unauthorized");

    expect(journal).toEqual(["secret.get"]);
  });

  it("answers 401 before 415: a wrong signature with a wrong media type is unauthorized", async () => {
    const { receive } = setup();

    expect(await receive(call({ token: "another-token", contentType: "text/plain" }))).toBe("unauthorized");
  });

  it("checks the media type after the signature and before the document", async () => {
    const { journal, receive } = setup();

    expect(await receive(call({ contentType: "text/plain" }))).toBe("unsupported_media");

    expect(journal).toEqual(["secret.get"]);
  });

  it.each([
    ["application/xml", true],
    ["application/xml; charset=utf-8", true],
    ["application/xml;charset=ISO-8859-1", true],
    ["Application/XML", true],
    ["  application/xml  ;  charset=x", true],
    ["text/xml", false],
    ["application/json", false],
    ["application/xml-dtd", false],
    ["application/xmlx", false],
    ["xml", false],
    ["", false],
    [undefined, false],
  ])("media type %j is accepted: %s", async (contentType, accepted) => {
    const { receive } = setup();

    expect(await receive(call({ contentType })) !== "unsupported_media").toBe(accepted);
  });

  it("validates the document only after the signature and the media type", async () => {
    const { journal, validator, receive } = setup();

    await receive(call());

    expect(journal).toEqual(["secret.get", "validator.event", "decisions.record"]);
    expect(validator.events[0]).toBe(eventXml({ reason: "Out of stock" }));
  });

  it("does not touch the table for a document that is not valid", async () => {
    const { journal, validator, receive } = setup();
    validator.eventResult = { valid: false, findings: [{ element: "Decision", rule: "value not allowed" }] };

    expect(await receive(call())).toBe("schema_invalid");

    expect(journal).toEqual(["secret.get", "validator.event"]);
  });
});

describe("WebhookService: the document", () => {
  it.each([
    ["not well-formed", { element: "(document)", rule: "not well-formed XML" }],
    ["a DOCTYPE", { element: "(document)", rule: "DOCTYPE not allowed" }],
    ["another encoding", { element: "(document)", rule: "encoding must be UTF-8" }],
  ])("answers malformed (400) for %s", async (_label, finding) => {
    const { validator, receive } = setup();
    validator.eventResult = { valid: false, findings: [finding] };

    expect(await receive(call())).toBe("malformed");
  });

  it.each([
    [{ element: "Decision", rule: "value not allowed" }],
    [{ element: "(document)", rule: "schema violation" }],
    [{ element: "(unknown)", rule: "unexpected element" }],
  ])("answers schema_invalid (422) for %j", async (finding) => {
    const { validator, receive } = setup();
    validator.eventResult = { valid: false, findings: [finding] };

    expect(await receive(call())).toBe("schema_invalid");
  });

  it("answers malformed for bytes that are not UTF-8, without asking the validator", async () => {
    const { journal, receive } = setup();
    const body = Buffer.concat([Buffer.from("<a>"), Buffer.from([0xff, 0xfe]), Buffer.from("</a>")]);

    expect(await receive(call({ body }))).toBe("malformed");

    expect(journal).toEqual(["secret.get"]);
  });

  it("answers schema_invalid when the validator accepts a document that cannot be read as an event", async () => {
    const { decisions, receive } = setup(); // the fake validator accepts everything

    expect(await receive(call({ body: Buffer.from("<something-else/>") }))).toBe("schema_invalid");
    expect(decisions.recorded).toEqual([]);
  });

  it("hands the validator the text without a BOM, so the two parsers see the same document", async () => {
    const { validator, decisions, receive } = setup();
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(eventXml())]);

    expect(await receive(call({ body }))).toBe("applied");

    expect(validator.events[0]?.startsWith("<?xml")).toBe(true);
    expect(decisions.recorded).toHaveLength(1);
  });
});

describe("WebhookService: applying the event", () => {
  it("stores the decision with both times as ISO UTC strings, the event id, and the time as a number", async () => {
    const { decisions, receive } = setup();
    const body = Buffer.from(eventXml({ occurredAt: "2026-10-21T14:15:32.250+04:00", decision: "Declined", reason: "Out of stock" }));

    expect(await receive(call({ body }))).toBe("applied");

    expect(decisions.recorded).toEqual([
      {
        requestId: REQUEST_ID,
        decision: {
          decision: "Declined",
          reason: "Out of stock",
          at: "2026-10-21T10:15:32.250Z",
          receivedAt: NOW.toISOString(),
          eventId: "3f0c6b1e-5a4d-4e7b-9c1a-2d6e8f0a1b3c",
        },
        occurredAtMs: Date.UTC(2026, 9, 21, 10, 15, 32, 250),
      },
    ]);
  });

  it("leaves reason out when the event has none", async () => {
    const { decisions, receive } = setup();

    await receive(call({ body: Buffer.from(eventXml()) }));

    expect(decisions.recorded[0]?.decision).not.toHaveProperty("reason");
  });

  it.each(["applied", "duplicate", "ignored", "unknown_request"] as const)("passes on the outcome %s of the repository", async (outcome) => {
    const { decisions, receive } = setup();
    decisions.outcome = outcome;

    expect(await receive(call())).toBe(outcome);
  });
});

describe("WebhookService: failures are not swallowed (the handler answers 500)", () => {
  it("of the token provider", async () => {
    const { secret, receive } = setup();
    secret.failWith = new Error("SSM down");

    await expect(receive(call())).rejects.toThrow("SSM down");
  });

  it("of the table", async () => {
    const { decisions, receive } = setup();
    decisions.failWith = new Error("throttled");

    await expect(receive(call())).rejects.toThrow("throttled");
  });
});

describe("WebhookService: logging", () => {
  it("writes one line per call: the outcome and ids, as info when the event was acknowledged and as a warning when refused", async () => {
    const { logs, decisions, receive } = setup();

    await receive(call());
    decisions.outcome = "duplicate";
    await receive(call());
    await receive(call({ token: "another-token" }));

    const handled = logs.entries().filter((entry) => entry.message === "Webhook handled");
    expect(handled.map(({ level, message, outcome }) => ({ level, message, outcome }))).toEqual([
      { level: "info", message: "Webhook handled", outcome: "applied" },
      { level: "info", message: "Webhook handled", outcome: "duplicate" },
      { level: "warn", message: "Webhook handled", outcome: "unauthorized" },
    ]);
    expect(handled[0]).toMatchObject({ requestId: REQUEST_ID, decision: "Approved" });
    expect(handled[2]).toMatchObject({ signatureProblem: "signature_mismatch" });
  });
});

// The request event of docs/api.md ("Logs", "Request events"): the decision is a change in the life
// of the request only when it was stored.
describe("WebhookService: request events", () => {
  const requestEvents = (logs: ReturnType<typeof setup>["logs"]) =>
    logs.entries().filter((entry) => entry.message === "Request event");

  it("decision_recorded: once, with the stored decision and no reason, when the decision is applied", async () => {
    const { logs, decisions, receive } = setup();

    await receive(call());

    expect(requestEvents(logs)).toEqual([
      {
        level: "info",
        message: "Request event",
        event: "decision_recorded",
        role: "recipient",
        requestId: REQUEST_ID,
        decision: "Approved",
      },
    ]);
    expect(decisions.recorded[0]?.decision.decision).toBe("Approved"); // the stored one
    expect(logs.lines.join("\n")).not.toContain("Out of stock"); // the Reason of the event
  });

  it.each(["duplicate", "ignored", "unknown_request"] as const)("is not written when the outcome is %s", async (outcome) => {
    const { logs, decisions, receive } = setup();
    decisions.outcome = outcome;

    await receive(call());

    expect(requestEvents(logs)).toEqual([]);
  });

  it("is not written for a call that was refused before the decision (bad signature)", async () => {
    const { logs, decisions, receive } = setup();

    await receive(call({ token: "another-token" }));

    expect(decisions.recorded).toEqual([]);
    expect(requestEvents(logs)).toEqual([]);
  });
});

// The webhook call carries no trace. The span `record decision` is recorded AFTER the update, in the
// trace that the update learned from the old item: it starts when the call began.
describe("WebhookService: the span `record decision`", () => {
  const spans = recordSpans();

  // A service whose clock is a moment in the recent past, so that the span has a real duration:
  // the start of the span is the time the call BEGAN, not the time the span is made.
  function setupLate(elapsedMs = 750) {
    const began = new Date(Date.now() - elapsedMs);
    const journal: Journal = [];
    const decisions = new FakeDecisions(journal);
    const logs = captureLogs();
    const service = new WebhookService(new FakeSecret(journal), new FakeXmlValidator(journal), decisions, () => began);
    const timestamp = String(Math.floor(began.getTime() / 1000));
    const receive = (change: Parameters<typeof call>[0] = {}) => service.receive(call({ timestamp, ...change }), createLogger("debug"));
    return { began, decisions, logs, receive };
  }

  it("is a child of the stored span, in its trace, with the ids and the outcome, and starts when the call began", async () => {
    const { began, decisions, receive } = setupLate();
    decisions.traceparent = STORED_TRACEPARENT;

    await receive();

    const span = spans.only("record decision");
    expect(parentIdOf(span)).toBe(STORED_SPAN_ID);
    expect(span.spanContext().traceId).toBe(STORED_TRACE_ID);
    expect(span.attributes).toEqual({ requestId: REQUEST_ID, decision: "Approved", outcome: "applied" });
    const startMs = span.startTime[0] * 1000 + span.startTime[1] / 1e6;
    expect(startMs).toBeCloseTo(began.getTime(), 0);
    const durationMs = span.duration[0] * 1000 + span.duration[1] / 1e6;
    expect(durationMs).toBeGreaterThanOrEqual(700); // the time since the call began, at least
  });

  it("is written for a duplicate or an ignored event too (the request is known), with the outcome that says so", async () => {
    const { decisions, receive } = setupLate();
    decisions.traceparent = STORED_TRACEPARENT;

    decisions.outcome = "duplicate";
    await receive();
    decisions.outcome = "ignored";
    await receive();

    expect(spans.named("record decision").map((span) => span.attributes.outcome)).toEqual(["duplicate", "ignored"]);
  });

  it("is not written when there is no trace stored with the request, or what is stored is not a trace", async () => {
    const { decisions, receive } = setupLate();

    await receive(); // the request has no trace (also what the repository says for an unknown request)
    decisions.traceparent = "not-a-traceparent";
    await receive();

    expect(spans.named("record decision")).toEqual([]);
  });

  it("is not written for a call that was refused before the decision", async () => {
    const { decisions, receive } = setupLate();
    decisions.traceparent = STORED_TRACEPARENT;

    await receive({ token: "another-token" });

    expect(spans.named("record decision")).toEqual([]);
  });

  it("logs the event of the request inside the span, so the line has the request's trace id, and never the reason", async () => {
    const { decisions, logs, receive } = setupLate();
    decisions.traceparent = STORED_TRACEPARENT;

    await receive();

    const event = logs.entries().find((entry) => entry.message === "Request event");
    expect(event).toMatchObject({ event: "decision_recorded", traceId: STORED_TRACE_ID });
    expect(wholeSpan(spans.only("record decision"))).not.toContain("Out of stock");
  });

  it("does not hide a failure of the table: the error is thrown, and no span is made", async () => {
    const { decisions, receive } = setupLate();
    decisions.traceparent = STORED_TRACEPARENT;
    decisions.failWith = new Error("throttled");

    await expect(receive()).rejects.toThrow("throttled");
    expect(spans.named("record decision")).toEqual([]);
  });
});
