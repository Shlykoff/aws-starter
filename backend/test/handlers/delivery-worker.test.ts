import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeSchema } from "../../src/domain/exchange";
import type { Exchange } from "../../src/domain/exchange";
import type { ApiKeyProvider } from "../../src/repositories/api-key-provider";
import { TOKENS } from "../../src/tokens";
import { lambdaContext } from "../helpers/events";
import { replyXml } from "../helpers/fakes";
import { stubTable } from "../helpers/fake-table";
import type { FakeTable } from "../helpers/fake-table";
import { captureLogs } from "../helpers/logs";
import { sqsEvent, sqsRecord } from "../helpers/pipeline-events";
import { STORED_SPAN_ID, STORED_TRACE_ID, parentIdOf, recordSpans } from "../helpers/tracing";
import { toXRayTraceHeader } from "../../src/lib/tracing";

// The real handler, service, adapters, XSD validator (libxml2 as WebAssembly, the real schema
// files) and container. Replaced: the AWS SDK's `send` (DynamoDB by an in-memory table, SNS,
// S3 and SSM by recorders) and the global `fetch` (the recipient). No network, no
// credentials.
// The schemas are read from contracts/xsd/ (in Lambda they are next to the bundle).
vi.mock("../../src/lib/schemas-location", () => ({
  SCHEMAS_DIRECTORY: new URL("../../../contracts/xsd/", import.meta.url),
}));

const ddb = mockClient(DynamoDBDocumentClient);
const sns = mockClient(SNSClient);
const s3 = mockClient(S3Client);
const ssm = mockClient(SSMClient);
const fetchFake = vi.fn<typeof fetch>();
let handler: typeof import("../../src/handlers/delivery-worker").handler;
let apiKeys: ApiKeyProvider;
let table: FakeTable;
let logs: ReturnType<typeof captureLogs>;

const idNumber = (n: number): string => `01J8Z3K5W0ABCDEFGHJKMN${String(n).padStart(4, "0")}`;
const API_KEY = "fake-partner-api-key-for-tests";

function seed(n: number, overrides: Record<string, unknown> = {}) {
  table.seed({
    pk: "USER#user-a",
    sk: `REQ#${idNumber(n)}`,
    id: idNumber(n),
    subject: "Order 42",
    body: "Please ship.",
    senderEmail: "sender@example.test",
    status: "queued",
    createdAt: "2026-09-21T09:00:00.000Z",
    ...overrides,
  });
}
const statusOf = (n: number): unknown =>
  table.items().find((item) => item.sk === `REQ#${idNumber(n)}`)?.status;

const message = (n: number, receiveCount = 1) =>
  sqsRecord({ messageId: `msg-${n}`, requestId: idNumber(n), receiveCount });
const run = (...records: ReturnType<typeof sqsRecord>[]) => handler(sqsEvent(...records), lambdaContext());

// The recipient answers every submission with this status and body (by default a Reply that
// belongs to the submission it got).
const idOf = (init: RequestInit | undefined): string => (init?.headers as Record<string, string>)["Idempotency-Key"] ?? "";
const acceptedReply = (id: string) => replyXml({ relatesTo: id });
const rejectedReply = (id: string) =>
  replyXml({ status: "Rejected", relatesTo: id, code: "RECIPIENT_REJECTED", description: "Refused by the rules" });
const respondWith = (status: number, reply?: (id: string) => string) =>
  fetchFake.mockImplementation((_url, init) =>
    Promise.resolve(new Response(reply ? reply(idOf(init)) : null, { status })),
  );

// What the worker wrote to S3, parsed and checked against the schema of the Exchange.
const recordsWritten = (): { key: string | undefined; exchange: Exchange }[] =>
  s3.commandCalls(PutObjectCommand).map((call) => ({
    key: call.args[0].input.Key,
    exchange: exchangeSchema.parse(JSON.parse(call.args[0].input.Body as string)),
  }));

beforeAll(async () => {
  // The partner client takes the global fetch when the container is built (at import), so
  // the fake must be in place before the handler is imported.
  vi.stubGlobal("fetch", fetchFake);
  ({ handler } = await import("../../src/handlers/delivery-worker"));
  // The provider keeps the key for 5 minutes, and lives as long as the container (that is,
  // the whole file). Every test starts with an empty cache, so that it can count the reads.
  const { container } = await import("../../src/container-worker");
  apiKeys = container.get<ApiKeyProvider>(TOKENS.ApiKeyProvider);
});
beforeEach(() => {
  apiKeys.invalidate();
  ddb.reset();
  sns.reset();
  s3.reset();
  ssm.reset();
  table = stubTable(ddb);
  sns.on(PublishCommand).resolves({});
  s3.on(PutObjectCommand).resolves({});
  ssm.on(GetParameterCommand).resolves({ Parameter: { Value: API_KEY } });
  fetchFake.mockReset();
  respondWith(200, acceptedReply);
  logs = captureLogs();
});
afterAll(() => {
  ddb.restore();
  sns.restore();
  s3.restore();
  ssm.restore();
  vi.unstubAllGlobals();
});

describe("delivery-worker: a delivered request", () => {
  it("sends the XML, records the exchange, sets sent and publishes", async () => {
    seed(1);

    const response = await run(message(1));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(statusOf(1)).toBe("sent");

    const [record] = recordsWritten();
    const put = s3.commandCalls(PutObjectCommand)[0]?.args[0].input;
    expect(put?.Bucket).toBe("test-deliveries");
    expect(put?.Key).toBe(`exchanges/${idNumber(1)}.json`);
    expect(put?.ContentType).toBe("application/json; charset=utf-8");
    expect(record?.exchange).toMatchObject({
      attempt: 1,
      outcome: "delivered",
      request: { valid: true, problems: [] },
      reply: { httpStatus: 200, xml: acceptedReply(idNumber(1)), valid: true, status: "Accepted" },
    });
    expect(record?.exchange.at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);

    const publish = sns.commandCalls(PublishCommand)[0]?.args[0].input;
    expect(publish?.TopicArn).toBe("arn:aws:sns:eu-north-1:000000000000:test-request-status");
    expect(publish?.MessageAttributes).toEqual({ status: { DataType: "String", StringValue: "sent" } });
    expect(JSON.parse(publish?.Message ?? "") as unknown).toEqual({
      requestId: idNumber(1),
      status: "sent",
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as string,
    });
  });

  it("POSTs to /v1/submissions with the API key from SSM and the request id as Idempotency-Key", async () => {
    seed(1, { senderEmail: "Smith & Sons", subject: "Fish <3", body: "a > b ]]> c" });

    await run(message(1));

    expect(ssm.commandCalls(GetParameterCommand)[0]?.args[0].input).toEqual({
      Name: "/test/partner-api-key",
      WithDecryption: true,
    });
    expect(fetchFake).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFake.mock.calls[0] ?? [];
    expect(url).toBe("https://partner.example.test/v1/submissions");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(init?.headers).toEqual({
      "X-API-Key": API_KEY,
      "Content-Type": "application/xml",
      "Idempotency-Key": idNumber(1),
      "User-Agent": "aws-starter-worker/1",
      Accept: "application/xml",
    });
    const xml = init?.body as string;
    expect(xml).toContain(`<MessageId>${idNumber(1)}</MessageId>`);
    expect(xml).toContain("<Sender><Name>Smith &amp; Sons</Name></Sender>");
    expect(xml).toContain("<Recipient><Name>Pharmacy</Name></Recipient>");
    expect(xml).toContain("<Subject>Fish &lt;3</Subject>");
    expect(xml).toContain("<Text>a &gt; b ]]&gt; c</Text>");
  });

  it("reads the API key once for many messages (it is cached for 5 minutes)", async () => {
    seed(1);
    seed(2);

    await run(message(1));
    await run(message(2));

    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(1);
    expect(fetchFake).toHaveBeenCalledTimes(2);
  });
});

describe("delivery-worker: the recipient refuses or is unavailable", () => {
  it("sets rejected for a 422 + Rejected, records it as refused and does not report the message", async () => {
    seed(1);
    respondWith(422, rejectedReply);

    const response = await run(message(1));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(statusOf(1)).toBe("rejected");
    expect(recordsWritten()[0]?.exchange).toMatchObject({
      outcome: "refused",
      reply: { httpStatus: 422, status: "Rejected", code: "RECIPIENT_REJECTED", description: "Refused by the rules" },
    });
    const publish = sns.commandCalls(PublishCommand)[0]?.args[0].input;
    expect(publish?.MessageAttributes?.status?.StringValue).toBe("rejected");
  });

  it.each([408, 429, 500, 503, 401, 403])("reports the message for a %i and leaves the request queued", async (status) => {
    seed(1);
    respondWith(status);

    const response = await run(message(1, 1));

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-1" }] });
    expect(statusOf(1)).toBe("queued");
    expect(sns.commandCalls(PublishCommand)).toHaveLength(0);
    // The record of a temporary failure is written, for diagnosis.
    expect(recordsWritten()[0]?.exchange).toMatchObject({ outcome: "retry", reply: { httpStatus: status, xml: null, valid: false } });
  });

  it.each([401, 403])("reads the key from SSM again after a %i (it may have been rotated)", async (status) => {
    seed(1);
    respondWith(status);

    await run(message(1));
    respondWith(200, acceptedReply);
    await run(message(1, 2));

    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(2);
    expect(statusOf(1)).toBe("sent");
  });

  it("reports the message when the recipient cannot be reached", async () => {
    seed(1);
    fetchFake.mockRejectedValue(new TypeError("fetch failed"));

    const response = await run(message(1, 1));

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-1" }] });
    expect(statusOf(1)).toBe("queued");
    expect(recordsWritten()[0]?.exchange).toMatchObject({ outcome: "retry", reply: null });
  });

  it("does not follow a redirect: it is a temporary failure, and the API key goes nowhere else", async () => {
    seed(1);
    fetchFake.mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { Location: "https://elsewhere.example.test/" } })),
    );

    const response = await run(message(1));

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-1" }] });
    expect(fetchFake).toHaveBeenCalledTimes(1);
    expect(recordsWritten()[0]?.exchange).toMatchObject({ outcome: "retry", reply: { httpStatus: 302 } });
  });

  it("treats a 200 whose body is not a valid Reply as a temporary failure", async () => {
    seed(1);
    fetchFake.mockImplementation(() => Promise.resolve(new Response("<html>gateway</html>", { status: 200 })));

    const response = await run(message(1));

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-1" }] });
    expect(statusOf(1)).toBe("queued");
    expect(recordsWritten()[0]?.exchange).toMatchObject({
      outcome: "retry",
      reply: { httpStatus: 200, xml: "<html>gateway</html>", valid: false },
    });
  });

  it("refuses a Reply with a DOCTYPE without parsing it, and treats it as a temporary failure", async () => {
    seed(1);
    const bomb = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><Reply>&b;</Reply>`;
    fetchFake.mockImplementation(() => Promise.resolve(new Response(bomb, { status: 200 })));

    const response = await run(message(1));

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-1" }] });
    expect(statusOf(1)).toBe("queued");
    expect(recordsWritten()[0]?.exchange.reply).toMatchObject({ valid: false });
  });

  it("treats a body above 64 KiB as a temporary failure, without reading all of it", async () => {
    seed(1);
    fetchFake.mockImplementation(() => Promise.resolve(new Response("x".repeat(70_000), { status: 200 })));

    const response = await run(message(1));

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-1" }] });
    expect(recordsWritten()[0]?.exchange.reply).toEqual({ httpStatus: 200, xml: null, valid: false });
  });

  it("on the last attempt sets failed, publishes it, and acknowledges the message (it is not reported)", async () => {
    seed(1);
    respondWith(503);

    const response = await run(message(1, 5));

    expect(statusOf(1)).toBe("failed");
    const publish = sns.commandCalls(PublishCommand)[0]?.args[0].input;
    expect(publish?.MessageAttributes?.status?.StringValue).toBe("failed");
    expect(response).toEqual({ batchItemFailures: [] });
    expect(recordsWritten()[0]?.exchange).toMatchObject({ attempt: 5, outcome: "retry" });
  });

  it("in a larger batch a message that fails for the last time is acknowledged and the next ones are still tried", async () => {
    seed(1);
    seed(2);
    respondWith(503);

    // Message 1 is on its last attempt, message 2 on its first: only message 2 goes back.
    const response = await run(message(1, 5), message(2, 1));

    expect(statusOf(1)).toBe("failed");
    expect(statusOf(2)).toBe("queued");
    expect(fetchFake).toHaveBeenCalledTimes(2);
    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-2" }] });
  });
});

describe("delivery-worker: a request that cannot be sent", () => {
  // PartyName (contracts/xsd/common-types.xsd) allows the common e-mail local-part characters
  // (letters, digits, . , ' & @ _ + -), because Sender/Name now carries the requester's e-mail:
  // a '+' (plus addressing, a real Gmail feature) and '_' must go through, not be rejected.
  it("sends a sender e-mail with '+' and '_' (real local-part characters), not rejected", async () => {
    seed(1, { senderEmail: "user+test_two@example.test" });

    const response = await run(message(1));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(statusOf(1)).toBe("sent");
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  it("rejects a sender e-mail with a character the recipient's schema still forbids, without calling anybody", async () => {
    // '!' is valid in an RFC 5322 local part but outside PartyName's pattern: the honest limit
    // documented in contracts/xsd/common-types.xsd (common characters, not the full grammar).
    seed(1, { senderEmail: "user!test@example.test" });

    const response = await run(message(1));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(statusOf(1)).toBe("rejected");
    expect(fetchFake).not.toHaveBeenCalled();
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(0);
    expect(recordsWritten()[0]?.exchange).toMatchObject({
      outcome: "invalid_request",
      request: { valid: false, problems: [{ element: "Name", rule: "does not match the allowed pattern" }] },
      reply: null,
    });
    expect(sns.commandCalls(PublishCommand)[0]?.args[0].input.MessageAttributes?.status?.StringValue).toBe("rejected");
  });

  it("rejects text that XML cannot carry, without calling anybody", async () => {
    seed(1, { body: "bad\u0000text" });

    const response = await run(message(1));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(statusOf(1)).toBe("rejected");
    expect(fetchFake).not.toHaveBeenCalled();
    expect(recordsWritten()[0]?.exchange).toMatchObject({
      outcome: "unrepresentable",
      request: { xml: "", valid: false, problems: [{ element: "Text", rule: "character not allowed in XML" }] },
    });
  });

  it("rejects text over the limits of the schema (5000 characters), without calling anybody", async () => {
    seed(1, { body: "x".repeat(5001) });

    await run(message(1));

    expect(statusOf(1)).toBe("rejected");
    expect(fetchFake).not.toHaveBeenCalled();
    expect(recordsWritten()[0]?.exchange).toMatchObject({
      outcome: "invalid_request",
      request: { problems: [{ element: "Text", rule: "too long" }] },
    });
  });
});

describe("delivery-worker: idempotency and batches", () => {
  it.each(["sent", "rejected", "failed"])("acknowledges a %s request without calling the recipient", async (status) => {
    seed(1, { status });

    const response = await run(message(1));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(fetchFake).not.toHaveBeenCalled();
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(statusOf(1)).toBe(status);
  });

  it("stops at the first failure: reports it and every message after it", async () => {
    seed(1);
    seed(2);
    seed(3);
    fetchFake
      .mockImplementationOnce((_url, init) => Promise.resolve(new Response(acceptedReply(idOf(init)), { status: 200 })))
      .mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 503 })));

    const response = await run(message(1), message(2), message(3));

    expect(response).toEqual({
      batchItemFailures: [{ itemIdentifier: "msg-2" }, { itemIdentifier: "msg-3" }],
    });
    expect(fetchFake).toHaveBeenCalledTimes(2);
    expect(statusOf(1)).toBe("sent");
    expect(statusOf(3)).toBe("queued");
  });

  it("reports a message whose body is not a delivery message", async () => {
    const response = await run(sqsRecord({ messageId: "msg-x", body: "not json" }));

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-x" }] });
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it("does not fail the message when SNS is down", async () => {
    seed(1);
    sns.on(PublishCommand).rejects(new Error("SNS down"));

    const response = await run(message(1));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(statusOf(1)).toBe("sent");
  });

  it("reports the message when the S3 put fails, so it is retried", async () => {
    seed(1);
    s3.on(PutObjectCommand).rejects(new Error("S3 down"));

    const response = await run(message(1));

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-1" }] });
    expect(statusOf(1)).toBe("queued");
  });

  it("reports the message when the API key cannot be read: an error of ours, no call to the recipient", async () => {
    seed(1);
    ssm.on(GetParameterCommand).rejects(new Error("AccessDeniedException"));

    const response = await run(message(1, 5));

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-1" }] });
    expect(fetchFake).not.toHaveBeenCalled();
    expect(statusOf(1)).toBe("queued");
  });
});

describe("delivery-worker: logging", () => {
  it("writes one info line per invocation with counts and the Lambda request id", async () => {
    seed(1);
    seed(2);
    fetchFake
      .mockImplementationOnce((_url, init) => Promise.resolve(new Response(acceptedReply(idOf(init)), { status: 200 })))
      .mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 503 })));

    await handler(sqsEvent(message(1), message(2)), lambdaContext("aws-request-2"));

    const summary = logs.entries().find((line) => line.message === "Delivery batch handled");
    expect(summary).toEqual({
      level: "info",
      message: "Delivery batch handled",
      awsRequestId: "aws-request-2",
      records: 2,
      sent: 1,
      rejected: 0,
      alreadyDone: 0,
      retry: 1,
      failed: 0,
      error: 0,
      undeliverable: 0,
      notAttempted: 0,
    });
  });

  it("never logs the request text, the reply text or the API key", async () => {
    const CANARY = "CANARY9f3a7c";
    seed(1, { senderEmail: `sender-${CANARY}@example.test`, subject: `Subject ${CANARY}`, body: `Text ${CANARY}` });
    seed(2, { senderEmail: `sender-${CANARY}#`, subject: `Subject ${CANARY}` });
    respondWith(422, (id) => replyXml({ status: "Rejected", relatesTo: id, code: "SCHEMA_INVALID", description: `The value '${CANARY}' is wrong` }));
    sns.on(PublishCommand).rejects(new Error("SNS down"));

    await run(message(1, 5));
    await run(message(2));
    respondWith(503);
    seed(3, { subject: `Subject ${CANARY}` });
    await run(message(3, 5));

    const everything = logs.lines.join("\n");
    expect(logs.lines.length).toBeGreaterThan(3);
    for (const secret of [CANARY, API_KEY, "<Submission", "<Reply", "is wrong"]) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe("delivery-worker: the trace of the request", () => {
  const spans = recordSpans();
  const traceHeader = toXRayTraceHeader(`00-${STORED_TRACE_ID}-${STORED_SPAN_ID}-01`);

  it("continues the trace that the message carries: its spans and the request events it logs are in it", async () => {
    seed(1);

    await run(sqsRecord({ messageId: "msg-1", requestId: idNumber(1), traceHeader }));

    const attempt = spans.only("deliver request");
    expect(attempt.spanContext().traceId).toBe(STORED_TRACE_ID);
    expect(parentIdOf(attempt)).toBe(STORED_SPAN_ID);
    // The container wraps the partner client, the store and the repositories: their spans are in it too.
    expect(spans.only("partner.send").spanContext().traceId).toBe(STORED_TRACE_ID);
    const sent = logs.entries().find((entry) => entry.event === "request_sent");
    expect(sent?.traceId).toBe(STORED_TRACE_ID);
  });

  it("makes no trace of the request for a message without a header", async () => {
    seed(1);

    await run(message(1));

    expect(spans.only("deliver request").spanContext().traceId).not.toBe(STORED_TRACE_ID);
  });
});
