import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lambdaContext } from "../helpers/events";
import { stubTable } from "../helpers/fake-table";
import type { FakeTable } from "../helpers/fake-table";
import { captureLogs } from "../helpers/logs";
import { sqsEvent, sqsRecord } from "../helpers/pipeline-events";

// The real handler, service, repositories, partner client and container. Replaced: the AWS
// SDK's `send` (DynamoDB by an in-memory table, SNS and S3 by recorders) and the global
// `fetch` (the partner). No network, no credentials: the ones below are fake values.
const ddb = mockClient(DynamoDBDocumentClient);
const sns = mockClient(SNSClient);
const s3 = mockClient(S3Client);
const fetchFake = vi.fn<typeof fetch>();
let handler: typeof import("../../src/handlers/delivery-worker").handler;
let table: FakeTable;
let logs: ReturnType<typeof captureLogs>;

const idNumber = (n: number): string => `01J8Z3K5W0ABCDEFGHJKMN${String(n).padStart(4, "0")}`;

function seed(n: number, status = "queued") {
  table.seed({
    pk: "USER#user-a",
    sk: `REQ#${idNumber(n)}`,
    id: idNumber(n),
    partner: "Acme",
    subject: "Order 42",
    body: "Please ship.",
    status,
    createdAt: "2026-09-21T09:00:00.000Z",
  });
}
const statusOf = (n: number): unknown =>
  table.items().find((item) => item.sk === `REQ#${idNumber(n)}`)?.status;

const message = (n: number, receiveCount = 1) =>
  sqsRecord({ messageId: `msg-${n}`, requestId: idNumber(n), receiveCount });
const run = (...records: ReturnType<typeof sqsRecord>[]) => handler(sqsEvent(...records), lambdaContext());
const respondWith = (status: number) => fetchFake.mockImplementation(() => Promise.resolve(new Response(null, { status })));

beforeAll(async () => {
  // The partner client takes the global fetch when the container is built (at import), so
  // the fake must be in place before the handler is imported.
  vi.stubGlobal("fetch", fetchFake);
  ({ handler } = await import("../../src/handlers/delivery-worker"));
});
beforeEach(() => {
  ddb.reset();
  sns.reset();
  s3.reset();
  table = stubTable(ddb);
  sns.on(PublishCommand).resolves({});
  s3.on(PutObjectCommand).resolves({});
  fetchFake.mockReset();
  respondWith(200);
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fake-secret-access-key-for-tests");
  vi.stubEnv("AWS_SESSION_TOKEN", "fake-session-token");
  logs = captureLogs();
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(() => {
  ddb.restore();
  sns.restore();
  s3.restore();
  vi.unstubAllGlobals();
});

describe("delivery-worker: a delivered request", () => {
  it("calls the partner, stores the audit copy, sets sent and publishes", async () => {
    seed(1);

    const response = await run(message(1));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(statusOf(1)).toBe("sent");

    const put = s3.commandCalls(PutObjectCommand)[0]?.args[0].input;
    expect(put?.Bucket).toBe("test-deliveries");
    expect(put?.Key).toBe(`deliveries/${idNumber(1)}.json`);
    expect(JSON.parse(put?.Body as string) as unknown).toEqual({
      sentAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as string,
      payload: {
        id: idNumber(1),
        partner: "Acme",
        subject: "Order 42",
        body: "Please ship.",
        createdAt: "2026-09-21T09:00:00.000Z",
      },
      partnerStatus: 200,
    });

    const publish = sns.commandCalls(PublishCommand)[0]?.args[0].input;
    expect(publish?.TopicArn).toBe("arn:aws:sns:eu-north-1:000000000000:test-request-status");
    expect(publish?.MessageAttributes).toEqual({ status: { DataType: "String", StringValue: "sent" } });
    expect(JSON.parse(publish?.Message ?? "") as unknown).toEqual({
      requestId: idNumber(1),
      status: "sent",
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as string,
    });
  });

  it("sends a SigV4-signed POST with the request id as Idempotency-Key", async () => {
    seed(1);

    await run(message(1));

    expect(fetchFake).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFake.mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(url).toBe("https://partner.example.test/");
    expect(init?.method).toBe("POST");
    expect(headers["idempotency-key"]).toBe(idNumber(1));
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-north-1\/lambda\/aws4_request, /,
    );
    expect(headers["x-amz-security-token"]).toBe("fake-session-token");
  });
});

describe("delivery-worker: the partner refuses or is unavailable", () => {
  it("sets rejected for a 422 and does not report the message", async () => {
    seed(1);
    respondWith(422);

    const response = await run(message(1));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(statusOf(1)).toBe("rejected");
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    const publish = sns.commandCalls(PublishCommand)[0]?.args[0].input;
    expect(publish?.MessageAttributes?.status?.StringValue).toBe("rejected");
  });

  it.each([408, 429, 503, 401, 403])("reports the message for a %i and leaves the request queued", async (status) => {
    seed(1);
    respondWith(status);

    const response = await run(message(1, 1));

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-1" }] });
    expect(statusOf(1)).toBe("queued");
    expect(sns.commandCalls(PublishCommand)).toHaveLength(0);
  });

  it("reports the message when the partner cannot be reached", async () => {
    seed(1);
    fetchFake.mockRejectedValue(new TypeError("fetch failed"));

    const response = await run(message(1, 1));

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-1" }] });
    expect(statusOf(1)).toBe("queued");
  });

  it("on the last attempt sets failed, publishes it, and still reports the message", async () => {
    seed(1);
    respondWith(503);

    const response = await run(message(1, 5));

    expect(statusOf(1)).toBe("failed");
    const publish = sns.commandCalls(PublishCommand)[0]?.args[0].input;
    expect(publish?.MessageAttributes?.status?.StringValue).toBe("failed");
    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-1" }] });
  });
});

describe("delivery-worker: idempotency and batches", () => {
  it.each(["sent", "rejected", "failed"])("acknowledges a %s request without calling the partner", async (status) => {
    seed(1, status);

    const response = await run(message(1));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(fetchFake).not.toHaveBeenCalled();
    expect(statusOf(1)).toBe(status);
  });

  it("stops at the first failure: reports it and every message after it", async () => {
    seed(1);
    seed(2);
    seed(3);
    fetchFake
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));

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
});

describe("delivery-worker: logging", () => {
  it("writes one info line per invocation with counts and the Lambda request id", async () => {
    seed(1);
    seed(2);
    respondWith(200);
    fetchFake.mockResolvedValueOnce(new Response(null, { status: 200 })).mockResolvedValueOnce(new Response(null, { status: 503 }));

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

  it("never logs the request text or the credentials", async () => {
    seed(1);
    respondWith(503);
    sns.on(PublishCommand).rejects(new Error("SNS down"));

    await run(message(1, 5));

    const everything = logs.lines.join("\n");
    for (const secret of ["Order 42", "Please ship.", "fake-secret-access-key-for-tests", "fake-session-token"]) {
      expect(everything).not.toContain(secret);
    }
  });
});
