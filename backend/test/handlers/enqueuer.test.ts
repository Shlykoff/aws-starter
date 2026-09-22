import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MESSAGE_GROUP_ID } from "../../src/domain/delivery-message";
import { handler } from "../../src/handlers/enqueuer";
import { stubTable } from "../helpers/fake-table";
import type { FakeTable } from "../helpers/fake-table";
import { captureLogs } from "../helpers/logs";
import { lambdaContext } from "../helpers/events";
import { sent } from "../helpers/sqs";
import { streamEvent, streamRecord } from "../helpers/pipeline-events";

// The real handler, service, repository and container. Only the AWS SDK's `send` is
// replaced: DynamoDB by an in-memory table, SQS by a recorder. QUEUE_URL and TABLE_NAME come
// from vitest.config.ts.
const ddb = mockClient(DynamoDBDocumentClient);
const sqs = mockClient(SQSClient);
let table: FakeTable;
let logs: ReturnType<typeof captureLogs>;

const QUEUE_URL = "https://sqs.eu-north-1.amazonaws.com/000000000000/test-deliveries.fifo";

const idNumber = (n: number): string => `01J8Z3K5W0ABCDEFGHJKMN${String(n).padStart(4, "0")}`;

// A stored request in status "created", plus the stream record that announces it.
function seededRecord(n: number, options: { ownerId?: string; status?: string } = {}) {
  const ownerId = options.ownerId ?? "user-a";
  table.seed({
    pk: `USER#${ownerId}`,
    sk: `REQ#${idNumber(n)}`,
    id: idNumber(n),
    subject: "Order 42",
    body: "Please ship.",
    senderEmail: "sender@example.test",
    status: options.status ?? "created",
    createdAt: "2026-09-21T09:00:00.000Z",
  });
  return streamRecord({
    sequenceNumber: `10000000000000000000${n}`,
    id: idNumber(n),
    ownerId,
  });
}

const statusOf = (n: number, ownerId = "user-a"): unknown =>
  table.items().find((item) => item.pk === `USER#${ownerId}` && item.sk === `REQ#${idNumber(n)}`)?.status;

const run = (...records: ReturnType<typeof streamRecord>[]) =>
  handler(streamEvent(...records), lambdaContext());

beforeEach(() => {
  ddb.reset();
  sqs.reset();
  table = stubTable(ddb);
  // By default SQS accepts every entry.
  sqs.on(SendMessageBatchCommand).callsFake((input: { Entries: { Id: string }[] }) => ({
    Successful: input.Entries.map((entry) => sent(entry.Id)),
    Failed: [],
  }));
  logs = captureLogs();
});
afterAll(() => {
  ddb.restore();
  sqs.restore();
});

describe("enqueuer: a new request", () => {
  it("sends one FIFO message and marks the request as queued", async () => {
    const response = await run(seededRecord(1));

    expect(response).toEqual({ batchItemFailures: [] });
    const calls = sqs.commandCalls(SendMessageBatchCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({
      QueueUrl: QUEUE_URL,
      Entries: [
        {
          Id: "100000000000000000001",
          MessageBody: JSON.stringify({ requestId: idNumber(1), ownerId: "user-a" }),
          MessageGroupId: MESSAGE_GROUP_ID,
          MessageDeduplicationId: idNumber(1),
        },
      ],
    });
    expect(statusOf(1)).toBe("queued");
  });

  it("takes the owner from the partition key, without the USER# prefix", async () => {
    await run(seededRecord(1, { ownerId: "eu-north-1:abc-123" }));

    const body = sqs.commandCalls(SendMessageBatchCommand)[0]?.args[0].input.Entries?.[0]?.MessageBody;
    expect(JSON.parse(body ?? "") as unknown).toEqual({
      requestId: idNumber(1),
      ownerId: "eu-north-1:abc-123",
    });
  });

  it("puts every request in the one fixed group: there is only one recipient", async () => {
    await run(seededRecord(1, { ownerId: "user-a" }), seededRecord(2, { ownerId: "user-b" }), seededRecord(3, { ownerId: "user-c" }));

    const groups = sqs.commandCalls(SendMessageBatchCommand)[0]?.args[0].input.Entries?.map((e) => e.MessageGroupId);
    expect(groups).toEqual([MESSAGE_GROUP_ID, MESSAGE_GROUP_ID, MESSAGE_GROUP_ID]);
  });

  it("sends at most 10 messages per call", async () => {
    const records = Array.from({ length: 25 }, (_, i) => seededRecord(i + 1));

    const response = await run(...records);

    const sizes = sqs.commandCalls(SendMessageBatchCommand).map((call) => call.args[0].input.Entries?.length);
    expect(sizes).toEqual([10, 10, 5]);
    expect(response.batchItemFailures).toEqual([]);
  });
});

// The owner sent a failed request again: the API set status `created` and counted the send
// (`retryCount`) in one update, which the stream shows as a MODIFY record. Only that kind of
// MODIFY goes onto the queue.
describe("enqueuer: a request sent again (MODIFY with status created and a retryCount)", () => {
  // The stored item is what the API left behind: created again, with the count.
  function retriedRecord(n: number, retryCount: number) {
    table.seed({
      pk: "USER#user-a",
      sk: `REQ#${idNumber(n)}`,
      id: idNumber(n),
      status: "created",
      retryCount,
    });
    return streamRecord({
      eventName: "MODIFY",
      sequenceNumber: `10000000000000000000${n}`,
      id: idNumber(n),
      retryCount,
    });
  }

  it("sends a message with the deduplication id <requestId>-r<retryCount> and marks the request queued", async () => {
    const response = await run(retriedRecord(1, 1));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(sqs.commandCalls(SendMessageBatchCommand)[0]?.args[0].input.Entries).toEqual([
      {
        Id: "100000000000000000001",
        MessageBody: JSON.stringify({ requestId: idNumber(1), ownerId: "user-a" }),
        MessageGroupId: MESSAGE_GROUP_ID,
        MessageDeduplicationId: `${idNumber(1)}-r1`,
      },
    ]);
    expect(statusOf(1)).toBe("queued");
  });

  it("uses the next number each time the request is sent again", async () => {
    await run(retriedRecord(1, 2));

    const entry = sqs.commandCalls(SendMessageBatchCommand)[0]?.args[0].input.Entries?.[0];
    expect(entry?.MessageDeduplicationId).toBe(`${idNumber(1)}-r2`);
  });

  it("handles it together with new requests in one batch: INSERT keeps the plain request id", async () => {
    await run(seededRecord(1), retriedRecord(2, 1));

    const entries = sqs.commandCalls(SendMessageBatchCommand)[0]?.args[0].input.Entries;
    expect(entries?.map((entry) => entry.MessageDeduplicationId)).toEqual([idNumber(1), `${idNumber(2)}-r1`]);
  });

  it.each(["queued", "sent", "failed", "rejected"])(
    "ignores a MODIFY whose new status is %s, even with a retryCount (a status update of the pipeline)",
    async (status) => {
      const response = await run(
        streamRecord({ eventName: "MODIFY", sequenceNumber: "1", id: idNumber(1), status, retryCount: 1 }),
      );

      expect(response).toEqual({ batchItemFailures: [] });
      expect(sqs.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
    },
  );

  it("ignores a MODIFY with status created but no retryCount", async () => {
    const response = await run(streamRecord({ eventName: "MODIFY", sequenceNumber: "1", id: idNumber(1) }));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(sqs.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
  });

  it("ignores a MODIFY whose retryCount is not a number", async () => {
    const record = streamRecord({ eventName: "MODIFY", sequenceNumber: "1", id: idNumber(1) });
    if (record.dynamodb?.NewImage) record.dynamodb.NewImage.retryCount = { S: "1" };

    const response = await run(record);

    expect(response).toEqual({ batchItemFailures: [] });
    expect(sqs.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
  });

  it("ignores a REMOVE, whatever its image looks like", async () => {
    const response = await run(
      streamRecord({ eventName: "REMOVE", sequenceNumber: "1", id: idNumber(1), status: "created", retryCount: 1 }),
    );

    expect(response).toEqual({ batchItemFailures: [] });
    expect(sqs.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
  });

  it("counts an ignored MODIFY as ignored and a retry MODIFY as sent in the log line", async () => {
    await run(
      retriedRecord(1, 1),
      streamRecord({ eventName: "MODIFY", sequenceNumber: "2", id: idNumber(2), status: "sent", retryCount: 1 }),
    );

    expect(logs.entries().find((line) => line.message === "Stream batch handled")).toMatchObject({
      records: 2,
      ignored: 1,
      sent: 1,
      queued: 1,
    });
  });
});

describe("enqueuer: records it must ignore", () => {
  it.each(["MODIFY", "REMOVE"] as const)("ignores a %s record", async (eventName) => {
    const response = await run(streamRecord({ eventName, sequenceNumber: "1", id: idNumber(1) }));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(sqs.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
  });

  it("handles the INSERT records of a mixed batch and ignores the rest", async () => {
    const response = await run(
      seededRecord(1),
      streamRecord({ eventName: "MODIFY", sequenceNumber: "2", id: idNumber(2) }),
      seededRecord(3),
    );

    const entries = sqs.commandCalls(SendMessageBatchCommand)[0]?.args[0].input.Entries;
    expect(entries?.map((entry) => entry.MessageDeduplicationId)).toEqual([idNumber(1), idNumber(3)]);
    expect(response.batchItemFailures).toEqual([]);
  });

  it("skips a malformed record without failing the batch, and still handles the good ones", async () => {
    const broken = streamRecord({
      sequenceNumber: "200",
      image: { pk: { S: "OWNER#user-a" }, id: { S: idNumber(2) }, subject: { S: "Secret subject" } }, // wrong pk prefix
    });

    const response = await run(seededRecord(1), broken, seededRecord(3));

    expect(response).toEqual({ batchItemFailures: [] }); // not reported: retrying cannot fix it
    const entries = sqs.commandCalls(SendMessageBatchCommand)[0]?.args[0].input.Entries;
    expect(entries?.map((entry) => entry.MessageDeduplicationId)).toEqual([idNumber(1), idNumber(3)]);
  });

  it.each([
    ["a wrong owner key", { pk: { S: "OWNER#x" }, id: { S: "r" } }],
    ["a missing id", { pk: { S: "USER#u" } }],
    ["an empty image", {}],
  ])("skips a record with %s", async (_label, image) => {
    const response = await run(streamRecord({ sequenceNumber: "1", image }));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(sqs.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
  });

  it("skips a record that has no NewImage or no sequence number", async () => {
    const noImage = streamRecord({ sequenceNumber: "1" });
    if (noImage.dynamodb) delete noImage.dynamodb.NewImage;
    const noSequence = seededRecord(2);
    if (noSequence.dynamodb) delete noSequence.dynamodb.SequenceNumber;

    const response = await run(noImage, noSequence);

    expect(response).toEqual({ batchItemFailures: [] });
    expect(sqs.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
  });

  it("logs a skipped record with its sequence number and the names of the bad fields, never the image", async () => {
    const broken = streamRecord({
      sequenceNumber: "200",
      image: { pk: { S: "OWNER#user-a" }, id: { S: idNumber(2) }, subject: { S: "Secret subject" } }, // wrong pk prefix
    });

    await run(broken);

    const skipped = logs.entries().find((line) => line.message === "Skipping a malformed stream record");
    expect(skipped).toMatchObject({ level: "error", sequenceNumber: "200", reason: "invalid_image_fields", invalidFields: ["pk"] });
    expect(logs.lines.join("\n")).not.toContain("Secret subject");
  });
});

describe("enqueuer: failures are reported per record", () => {
  it("reports only the records SQS refused (a partial SendMessageBatch failure)", async () => {
    const records = [seededRecord(1), seededRecord(2), seededRecord(3)];
    const refusedId = records[1]?.dynamodb?.SequenceNumber ?? "";
    sqs.on(SendMessageBatchCommand).resolves({
      Successful: [sent(records[0]?.dynamodb?.SequenceNumber), sent(records[2]?.dynamodb?.SequenceNumber)],
      Failed: [{ Id: refusedId, Code: "InternalError", SenderFault: false }],
    });

    const response = await run(...records);

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: refusedId }] });
    expect(statusOf(1)).toBe("queued");
    expect(statusOf(2)).toBe("created"); // not queued: its message was not sent
    expect(statusOf(3)).toBe("queued");
  });

  it("reports every record of a call that failed as a whole", async () => {
    sqs.on(SendMessageBatchCommand).rejects(new Error("AccessDenied"));
    const records = [seededRecord(1), seededRecord(2)];

    const response = await run(...records);

    expect(response.batchItemFailures.map((failure) => failure.itemIdentifier)).toEqual(
      records.map((record) => record.dynamodb?.SequenceNumber),
    );
    expect(statusOf(1)).toBe("created");
  });

  it("does not report a record whose conditional update lost the race: the request is already handled", async () => {
    // The stream record still says "created", but the worker was faster and the stored item is "sent".
    const record = seededRecord(1, { status: "sent" });

    const response = await run(record);

    expect(response).toEqual({ batchItemFailures: [] });
    expect(statusOf(1)).toBe("sent"); // still sent, not moved back to queued
  });

  it("reports a record whose status update fails for another reason, so the record is retried", async () => {
    const record = seededRecord(1);
    ddb.reset();
    ddb.rejects(new Error("ProvisionedThroughputExceededException"));

    const response = await run(record);

    expect(response).toEqual({
      batchItemFailures: [{ itemIdentifier: record.dynamodb?.SequenceNumber }],
    });
  });
});

describe("enqueuer: logging", () => {
  it("writes one info line per invocation with counts and the Lambda request id", async () => {
    sqs.on(SendMessageBatchCommand).callsFake((input: { Entries: { Id: string }[] }) => ({
      Successful: input.Entries.slice(0, 1).map((entry) => sent(entry.Id)),
      Failed: input.Entries.slice(1).map((entry) => ({ Id: entry.Id, Code: "InternalError", SenderFault: false })),
    }));

    await handler(
      streamEvent(
        seededRecord(1),
        seededRecord(2),
        streamRecord({ eventName: "MODIFY", sequenceNumber: "3", id: idNumber(3) }),
        streamRecord({ sequenceNumber: "4", image: {} }),
      ),
      lambdaContext("aws-request-1"),
    );

    const summaries = logs.entries().filter((line) => line.message === "Stream batch handled");
    expect(summaries).toEqual([
      {
        level: "info",
        message: "Stream batch handled",
        awsRequestId: "aws-request-1",
        records: 4,
        ignored: 1,
        malformed: 1,
        sent: 1,
        queued: 1,
        alreadyMoved: 0,
        failed: 1,
      },
    ]);
  });

  it("never logs the request text", async () => {
    sqs.on(SendMessageBatchCommand).rejects(new Error("AccessDenied"));

    await run(seededRecord(1), streamRecord({ sequenceNumber: "9", image: {} }));

    const everything = logs.lines.join("\n");
    expect(everything).not.toContain("Order 42");
    expect(everything).not.toContain("Please ship.");
  });
});

// The webhook stores the client's decision on the request item (clientDecision, decisionAtMs).
// That is a MODIFY record in the stream, and the new attributes may also be in the image of a
// later record: neither may break the enqueuer, queue a request twice or reach the queue.
describe("enqueuer: the client's decision in the stream", () => {
  const decisionImage = (n: number) => ({
    pk: { S: "USER#user-a" },
    sk: { S: `REQ#${idNumber(n)}` },
    id: { S: idNumber(n) },
    subject: { S: "Order 42" },
    body: { S: "Please ship." },
    status: { S: "sent" },
    createdAt: { S: "2026-09-21T09:00:00.000Z" },
    decisionAtMs: { N: "1789985732000" },
    clientDecision: {
      M: {
        decision: { S: "Declined" },
        reason: { S: "Out of stock" },
        at: { S: "2026-09-21T10:15:32.000Z" },
        receivedAt: { S: "2026-09-21T10:15:40.000Z" },
        eventId: { S: "3f0c6b1e-5a4d-4e7b-9c1a-2d6e8f0a1b3c" },
      },
    },
  });

  it("does not queue a request again when a decision is stored (a MODIFY record)", async () => {
    table.seed({ pk: "USER#user-a", sk: `REQ#${idNumber(1)}`, id: idNumber(1), status: "sent" });

    const response = await run(streamRecord({ eventName: "MODIFY", sequenceNumber: "100000000000000000001", image: decisionImage(1) }));

    expect(response).toEqual({ batchItemFailures: [] });
    expect(sqs.commandCalls(SendMessageBatchCommand)).toHaveLength(0);
    expect(statusOf(1)).toBe("sent");
  });

  it("still enqueues a request whose image carries the decision attributes, and puts ids only on the queue", async () => {
    table.seed({ pk: "USER#user-a", sk: `REQ#${idNumber(1)}`, id: idNumber(1), status: "created" });

    const response = await run(streamRecord({ sequenceNumber: "100000000000000000001", image: decisionImage(1) }));

    expect(response).toEqual({ batchItemFailures: [] });
    const body = sqs.commandCalls(SendMessageBatchCommand)[0]?.args[0].input.Entries?.[0]?.MessageBody;
    expect(JSON.parse(body ?? "") as unknown).toEqual({ requestId: idNumber(1), ownerId: "user-a" });
    expect(body).not.toContain("Declined");
    expect(body).not.toContain("eventId");
  });
});
