import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { AttributeValue } from "aws-lambda";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handler as createRequest } from "../../src/handlers/create-request";
import { handler as enqueuer } from "../../src/handlers/enqueuer";
import { handler as getRequest } from "../../src/handlers/get-request";
import { handler as listRequests } from "../../src/handlers/list-requests";
import { handler as receiveWebhook } from "../../src/handlers/receive-webhook";
import { handler as retryRequest } from "../../src/handlers/retry-request";
import { withSpan } from "../../src/lib/tracing";
import { createRequestEvent, getRequestEvent, lambdaContext, listRequestsEvent, retryRequestEvent } from "../helpers/events";
import { stubTable } from "../helpers/fake-table";
import type { FakeTable, StoredItem } from "../helpers/fake-table";
import { captureLogs } from "../helpers/logs";
import { streamEvent, streamRecord } from "../helpers/pipeline-events";
import { sent } from "../helpers/sqs";
import { STORED_SPAN_ID, STORED_TRACEPARENT, STORED_TRACE_ID, parentIdOf, recordSpans, traceparentOf, wholeSpan } from "../helpers/tracing";
import { WEBHOOK_TOKEN, eventXml, webhookEvent } from "../helpers/webhook";

// One request is ONE trace: create-request -> (stream) -> enqueuer -> (queue) -> ... -> webhook.
// The real handlers, services, repositories, ports wrapped by `tracedPort`, containers and the
// XSD validator; only the AWS SDK's `send` is replaced (DynamoDB by an in-memory table, SQS and
// SSM by recorders). A real provider records the spans. In Lambda the layer makes the span of
// each INVOCATION (and joins the trace of a queue message by itself): here `invoke` does that,
// so every function starts with a span of its own, in a trace of its own, as it does there.
vi.mock("../../src/lib/schemas-location", () => ({
  SCHEMAS_DIRECTORY: new URL("../../../contracts/xsd/", import.meta.url),
}));

const ddb = mockClient(DynamoDBDocumentClient);
const sqs = mockClient(SQSClient);
const ssm = mockClient(SSMClient);
let table: FakeTable;
let logs: ReturnType<typeof captureLogs>;

beforeEach(() => {
  ddb.reset();
  sqs.reset();
  ssm.reset();
  table = stubTable(ddb);
  sqs.on(SendMessageBatchCommand).callsFake((input: { Entries: { Id: string }[] }) => ({
    Successful: input.Entries.map((entry) => sent(entry.Id)),
    Failed: [],
  }));
  ssm.on(GetParameterCommand).resolves({ Parameter: { Value: WEBHOOK_TOKEN } });
  logs = captureLogs();
});
afterAll(() => {
  ddb.restore();
  sqs.restore();
  ssm.restore();
});

const CANARY_REASON = "Out of stock canary";
const CANARY_TEXT = "Please ship canary";
const body = JSON.stringify({ partner: "Acme", subject: "Order 42", body: CANARY_TEXT });

// The invocation span that the layer makes: it starts a NEW trace, as for a stream or an HTTP call.
const invoke = <T>(name: string, fn: () => Promise<T>): Promise<T> => withSpan(name, {}, fn);
const json = (response: { body?: string }): Record<string, unknown> => JSON.parse(response.body ?? "null") as Record<string, unknown>;
const storedItems = (): StoredItem[] => table.items();
// The pipeline would move the request on: here the table is changed by hand.
const setStatus = (id: string, status: string): void => {
  const item = storedItems().find((stored) => stored.id === id) as StoredItem;
  table.seed({ ...item, status });
};
const requestEventLines = () => logs.entries().filter((entry) => entry.message === "Request event");
const eventLine = (event: string) => requestEventLines().find((entry) => entry.event === event);
const xrayHeaderOf = (traceId: string, spanId: string): string => `Root=1-${traceId.slice(0, 8)}-${traceId.slice(8)};Parent=${spanId};Sampled=1`;

// The stream record of an item as DynamoDB shows it: the whole item, in its typed format.
const recordOf = (item: StoredItem) =>
  streamRecord({ sequenceNumber: "100000000000000000001", image: marshall(item) as Record<string, AttributeValue> });
const sentEntries = () =>
  sqs.commandCalls(SendMessageBatchCommand).flatMap((call) => call.args[0].input.Entries ?? []);

describe("one request, one trace", () => {
  const spans = recordSpans();

  it("carries the trace from create-request through the stream and the queue to the webhook", async () => {
    // 1. create-request: the span `create request` is the start of the trace, and its traceparent is stored.
    const created = await invoke("invoke create-request", () => createRequest(createRequestEvent({ body }), lambdaContext()));
    expect(created.statusCode).toBe(201);
    const id = json(created).id as string;
    const createSpan = spans.only("create request");
    const traceId = createSpan.spanContext().traceId;
    expect(traceId).toBe(spans.only("invoke create-request").spanContext().traceId);
    expect(parentIdOf(createSpan)).toBe(spans.only("invoke create-request").spanContext().spanId);
    expect(createSpan.attributes).toEqual({ requestId: id });
    // The item has it, from the same write; the DynamoDB call is a child of the span.
    expect(storedItems()).toEqual([expect.objectContaining({ id, traceparent: traceparentOf(createSpan) })]);
    expect(parentIdOf(spans.only("requests.create"))).toBe(createSpan.spanContext().spanId);
    expect(eventLine("request_created")?.traceId).toBe(traceId);

    // 2. The stream shows the item to the enqueuer, which is another invocation: another trace.
    const stored = storedItems()[0] as StoredItem;
    const enqueued = await invoke("invoke enqueuer", () => enqueuer(streamEvent(recordOf(stored)), lambdaContext()));
    expect(enqueued).toEqual({ batchItemFailures: [] });
    const enqueueSpan = spans.only("enqueue request");
    // Its span continues the stored trace: same trace, the creation as parent.
    expect(enqueueSpan.spanContext().traceId).toBe(traceId);
    expect(parentIdOf(enqueueSpan)).toBe(createSpan.spanContext().spanId);
    expect(enqueueSpan.spanContext().traceId).not.toBe(spans.only("invoke enqueuer").spanContext().traceId);
    expect(enqueueSpan.attributes).toEqual({ requestId: id, outcome: "queued" });
    // The message hands the trace on: the worker's invocation becomes a child of `enqueue request`.
    expect(sentEntries().map((entry) => entry.MessageSystemAttributes)).toEqual([
      { AWSTraceHeader: { DataType: "String", StringValue: xrayHeaderOf(traceId, enqueueSpan.spanContext().spanId) } },
    ]);
    // Marking the request is one of its spans; the SQS call for the whole batch belongs to the invocation.
    expect(parentIdOf(spans.only("deliveries.markQueued"))).toBe(enqueueSpan.spanContext().spanId);
    expect(spans.only("queue.sendBatch").spanContext().traceId).toBe(spans.only("invoke enqueuer").spanContext().traceId);
    expect(eventLine("request_queued")?.traceId).toBe(traceId);

    // 3. The webhook, much later: no trace in the call. Its span is recorded in the stored one.
    const before = Date.now();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const decided = await invoke("invoke webhook", () =>
      receiveWebhook(webhookEvent({ body: eventXml({ relatesTo: id, decision: "Declined", reason: CANARY_REASON }), timestamp }), lambdaContext()),
    );
    expect(decided.statusCode).toBe(200);
    const decisionSpan = spans.only("record decision");
    expect(decisionSpan.spanContext().traceId).toBe(traceId);
    expect(parentIdOf(decisionSpan)).toBe(createSpan.spanContext().spanId);
    expect(decisionSpan.attributes).toEqual({ requestId: id, decision: "Declined", outcome: "applied" });
    expect(eventLine("decision_recorded")?.traceId).toBe(traceId);
    // It starts when the call began (not when the span was made) and ends after the update.
    const toMs = (time: [number, number]): number => time[0] * 1000 + time[1] / 1e6;
    expect(toMs(decisionSpan.startTime)).toBeGreaterThanOrEqual(before);
    expect(toMs(decisionSpan.endTime)).toBeGreaterThanOrEqual(toMs(decisionSpan.startTime));

    // Nothing of the request text, the partner or the reason is in any span.
    for (const span of spans.all()) {
      expect(wholeSpan(span), span.name).not.toContain(CANARY_TEXT);
      expect(wholeSpan(span), span.name).not.toContain(CANARY_REASON);
      expect(wholeSpan(span), span.name).not.toContain("Acme");
    }
    // Every line of the request's timeline that the three functions wrote has the same trace id.
    expect(requestEventLines().map((entry) => entry.traceId)).toEqual([traceId, traceId, traceId]);
  });

  it("starts a new trace for a request that is sent again, and the stream carries it on", async () => {
    const id = "01J8Z3K5W0ABCDEFGHJKMNPQRS";
    table.seed({
      pk: "USER#user-a", sk: `REQ#${id}`, id, partner: "Acme", subject: "Order 42", body: "Please ship.",
      status: "failed", createdAt: "2026-09-21T09:00:00.000Z", retryCount: 1, traceparent: STORED_TRACEPARENT,
    });

    const response = await invoke("invoke retry-request", () => retryRequest(retryRequestEvent({ id }), lambdaContext()));

    expect(response.statusCode).toBe(200);
    const retrySpan = spans.only("retry request");
    expect(retrySpan.attributes).toEqual({ requestId: id });
    expect(retrySpan.spanContext().traceId).not.toBe(STORED_TRACE_ID);
    // The same update replaced the trace, and counted the send.
    expect(storedItems()[0]).toMatchObject({ status: "created", retryCount: 2, traceparent: traceparentOf(retrySpan) });
    expect(eventLine("retry_requested")?.traceId).toBe(retrySpan.spanContext().traceId);

    // The enqueuer then sends the NEW trace, not the old one.
    await invoke("invoke enqueuer", () => enqueuer(streamEvent(recordOf(storedItems()[0] as StoredItem)), lambdaContext()));
    expect(spans.only("enqueue request").spanContext().traceId).toBe(retrySpan.spanContext().traceId);
    expect(sentEntries()[0]?.MessageSystemAttributes?.AWSTraceHeader?.StringValue).toContain(`Root=1-${retrySpan.spanContext().traceId.slice(0, 8)}`);
  });

  it("does not leave the trace of a request out of the answers of the API", async () => {
    const created = await invoke("invoke create-request", () => createRequest(createRequestEvent({ body }), lambdaContext()));
    const id = json(created).id as string;
    const traceId = spans.only("create request").spanContext().traceId;
    setStatus(id, "failed");

    const answers = [
      created,
      await getRequest(getRequestEvent({ id }), lambdaContext()),
      await listRequests(listRequestsEvent(), lambdaContext()),
      await retryRequest(retryRequestEvent({ id }), lambdaContext()),
    ];

    // The item does hold it; no answer does.
    expect(storedItems()[0]).toHaveProperty("traceparent");
    for (const answer of answers) {
      expect(answer.body, String(answer.statusCode)).not.toContain("traceparent");
      expect(answer.body).not.toContain(traceId);
    }
  });

  describe("a request without a usable trace", () => {
    const seedRequest = (extra: Record<string, unknown>) => {
      const id = "01J8Z3K5W0ABCDEFGHJKMNPQRT";
      table.seed({
        pk: "USER#user-a", sk: `REQ#${id}`, id, partner: "Acme", subject: "Order 42", body: "Please ship.",
        status: "created", createdAt: "2026-09-21T09:00:00.000Z", ...extra,
      });
      return id;
    };

    it.each([
      ["no traceparent", {}],
      ["a malformed one", { traceparent: "garbage" }],
      ["an upper case one", { traceparent: STORED_TRACEPARENT.toUpperCase() }],
      ["one that is not a string", { traceparent: 42 }],
    ])("is still enqueued when it has %s: its span belongs to the invocation's trace", async (_name, extra) => {
      const id = seedRequest(extra);

      const response = await invoke("invoke enqueuer", () => enqueuer(streamEvent(recordOf(storedItems()[0] as StoredItem)), lambdaContext()));

      // The record is neither skipped nor failed, and the request is queued.
      expect(response).toEqual({ batchItemFailures: [] });
      expect(logs.entries().filter((entry) => entry.message === "Skipping a malformed stream record")).toEqual([]);
      expect(storedItems()[0]).toMatchObject({ id, status: "queued" });
      const invocation = spans.only("invoke enqueuer");
      const enqueueSpan = spans.only("enqueue request");
      expect(parentIdOf(enqueueSpan)).toBe(invocation.spanContext().spanId);
      expect(sentEntries()[0]?.MessageSystemAttributes?.AWSTraceHeader?.StringValue).toBe(
        xrayHeaderOf(invocation.spanContext().traceId, enqueueSpan.spanContext().spanId),
      );
    });

    it("gets no `record decision` span from the webhook, and the decision is still stored", async () => {
      const id = seedRequest({ status: "sent", traceparent: "garbage" });
      const timestamp = String(Math.floor(Date.now() / 1000));

      const response = await invoke("invoke webhook", () =>
        receiveWebhook(webhookEvent({ body: eventXml({ relatesTo: id }), timestamp }), lambdaContext()),
      );

      expect(response.statusCode).toBe(200);
      expect(storedItems()[0]).toHaveProperty("clientDecision");
      expect(spans.named("record decision")).toEqual([]);
    });

    it("gets no span for a duplicate of an event on a request that has no trace either", async () => {
      const id = seedRequest({ status: "sent" });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const event = webhookEvent({ body: eventXml({ relatesTo: id }), timestamp });

      await receiveWebhook(event, lambdaContext());
      await receiveWebhook(event, lambdaContext());

      expect(spans.named("record decision")).toEqual([]);
    });
  });

  it("records the span of a duplicate event too, with the outcome that says so", async () => {
    const id = "01J8Z3K5W0ABCDEFGHJKMNPQRV";
    table.seed({
      pk: "USER#user-a", sk: `REQ#${id}`, id, partner: "Acme", subject: "Order 42", body: "Please ship.",
      status: "sent", createdAt: "2026-09-21T09:00:00.000Z", traceparent: STORED_TRACEPARENT,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const event = webhookEvent({ body: eventXml({ relatesTo: id }), timestamp });

    await receiveWebhook(event, lambdaContext());
    await receiveWebhook(event, lambdaContext());

    // Both calls read the trace: from the old item that the update hands back, and from the one
    // that a failed condition hands back.
    expect(spans.named("record decision").map((span) => span.attributes.outcome)).toEqual(["applied", "duplicate"]);
    for (const span of spans.named("record decision")) {
      expect(parentIdOf(span)).toBe(STORED_SPAN_ID);
      expect(span.spanContext().traceId).toBe(STORED_TRACE_ID);
    }
    // Only the applied one is an event of the request.
    expect(requestEventLines().filter((entry) => entry.event === "decision_recorded")).toHaveLength(1);
  });
});

describe("without an SDK (the tests, a local run)", () => {
  it("stores no traceparent, sends no trace header and records no span", async () => {
    const created = await createRequest(createRequestEvent({ body }), lambdaContext());
    const id = json(created).id as string;
    expect(created.statusCode).toBe(201);
    expect(storedItems()[0]).not.toHaveProperty("traceparent");

    await enqueuer(streamEvent(recordOf(storedItems()[0] as StoredItem)), lambdaContext());
    expect(sentEntries()).toHaveLength(1);
    expect(sentEntries()[0]).not.toHaveProperty("MessageSystemAttributes");

    setStatus(id, "failed");
    await retryRequest(retryRequestEvent({ id }), lambdaContext());
    expect(storedItems()[0]).not.toHaveProperty("traceparent");

    // No line of the log carries a trace id either.
    expect(requestEventLines().length).toBeGreaterThan(0);
    for (const line of requestEventLines()) expect(line).not.toHaveProperty("traceId");
  });
});
