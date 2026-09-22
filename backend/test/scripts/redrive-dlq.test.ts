import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MESSAGE_GROUP_ID as MESSAGE_GROUP_ID_REAL, decodeDeliveryMessage as decodeDeliveryMessageReal } from "../../src/domain/delivery-message";
import { ownerKey as ownerKeyReal, requestKey as requestKeyReal } from "../../src/domain/request-keys";

// backend/scripts/redrive-dlq.mjs is plain JS run with `node`, not part of the TypeScript
// project (the project has no `allowJs`, and the script deliberately does not import
// backend/src/). A statically-typed `import "../../scripts/redrive-dlq.mjs"` would make tsc
// try, and fail, to resolve it as a TypeScript module. Loading it through a runtime-computed
// path sidesteps that: tsc cannot resolve a dynamic string built at runtime, so it types the
// result as `any`, which the interface below then shapes for the rest of this file.
interface DlqScript {
  ownerKey: (ownerId: string) => string;
  requestKey: (id: string) => string;
  MESSAGE_GROUP_ID: string;
  decodeDeliveryMessage: (body: string) => { requestId: string; ownerId: string } | undefined;
  list: (sqs: SQSClient, ddb: DynamoDBDocumentClient, config: { dlqUrl: string; tableName: string }) => Promise<void>;
  redrive: (
    sqs: SQSClient,
    ddb: DynamoDBDocumentClient,
    config: { dlqUrl: string; queueUrl: string; tableName: string },
    messageId: string,
  ) => Promise<void>;
  discard: (sqs: SQSClient, config: { dlqUrl: string }, messageId: string) => Promise<void>;
}

let script: DlqScript;

beforeAll(async () => {
  const scriptPath = new URL("../../scripts/redrive-dlq.mjs", import.meta.url).href;
  script = (await import(scriptPath)) as DlqScript;
});

// Same mocking style as test/repositories/aws-adapters.test.ts: mockClient patches the
// clients' prototype, so any instance (the ones below) is intercepted. No network, no
// credentials.
const sqs = mockClient(SQSClient);
const ddb = mockClient(DynamoDBDocumentClient);
const sqsClient = new SQSClient({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

afterEach(() => {
  sqs.reset();
  ddb.reset();
  // The script sets this on a refusal instead of calling process.exit() (which would kill the
  // test worker); reset it so one test's failure path cannot leak into the next test's result.
  process.exitCode = undefined;
});
afterAll(() => {
  sqs.restore();
  ddb.restore();
});

const DLQ_URL = "https://sqs.eu-north-1.amazonaws.com/000000000000/demo-dev-deliveries-dlq.fifo";
const QUEUE_URL = "https://sqs.eu-north-1.amazonaws.com/000000000000/demo-dev-deliveries.fifo";
const TABLE_NAME = "demo-dev-requests";
const REQUEST_ID = "01J8Z3K5W0ABCDEFGHJKMNPQRS";
const config = { dlqUrl: DLQ_URL, queueUrl: QUEUE_URL, tableName: TABLE_NAME };

function dlqMessage(overrides: { MessageId?: string; ReceiptHandle?: string; Body?: string; Attributes?: Record<string, string> } = {}) {
  return {
    MessageId: "msg-1",
    ReceiptHandle: "receipt-1",
    Body: JSON.stringify({ requestId: REQUEST_ID, ownerId: "user-a" }),
    Attributes: { SentTimestamp: String(Date.now() - 5_000), ApproximateReceiveCount: "5" },
    ...overrides,
  };
}

function loggedLines(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((call) => String(call[0])).join("\n");
}

describe("list", () => {
  it("prints requestId, senderEmail and status for a decodable message with a matching row", async () => {
    sqs.on(ReceiveMessageCommand).resolves({ Messages: [dlqMessage()] });
    ddb.on(GetCommand).resolves({ Item: { senderEmail: "sender@example.test", status: "failed", subject: "Order 42" } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await script.list(sqsClient, ddbClient, config);

    const output = loggedLines(log);
    expect(output).toContain(`requestId=${REQUEST_ID}`);
    expect(output).toContain("senderEmail=sender@example.test");
    expect(output).toContain("status=failed");
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(sqs.commandCalls(DeleteMessageCommand)).toHaveLength(0);
  });

  it("prints 'not decodable' for a malformed body, without querying DynamoDB", async () => {
    sqs.on(ReceiveMessageCommand).resolves({ Messages: [dlqMessage({ Body: "{not json" })] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await script.list(sqsClient, ddbClient, config);

    expect(loggedLines(log)).toContain("not decodable — can only be discarded");
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(sqs.commandCalls(DeleteMessageCommand)).toHaveLength(0);
  });

  it("prints 'request not found' when the table has no matching item", async () => {
    sqs.on(ReceiveMessageCommand).resolves({ Messages: [dlqMessage()] });
    ddb.on(GetCommand).resolves({});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await script.list(sqsClient, ddbClient, config);

    expect(loggedLines(log)).toContain("request not found — can only be discarded");
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(sqs.commandCalls(DeleteMessageCommand)).toHaveLength(0);
  });
});

describe("redrive", () => {
  it("sends with the right group id and a fresh dedup id, carries the trace header, and deletes from the DLQ only after the send", async () => {
    const traceHeader = "Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1";
    sqs.on(ReceiveMessageCommand).resolves({
      Messages: [dlqMessage({ Attributes: { SentTimestamp: String(Date.now()), ApproximateReceiveCount: "5", AWSTraceHeader: traceHeader } })],
    });
    ddb.on(GetCommand).resolves({ Item: { status: "failed" } });
    sqs.on(SendMessageCommand).resolves({ MessageId: "sqs-new-id" });
    sqs.on(DeleteMessageCommand).resolves({});

    await script.redrive(sqsClient, ddbClient, config, "msg-1");

    const sendCalls = sqs.commandCalls(SendMessageCommand);
    expect(sendCalls).toHaveLength(1);
    const sent = sendCalls[0]?.args[0].input;
    expect(sent?.QueueUrl).toBe(QUEUE_URL);
    expect(sent?.MessageGroupId).toBe(MESSAGE_GROUP_ID_REAL);
    // A fresh id, never the shapes the real enqueuer uses for a first send (`requestId`) or a
    // retry (`requestId-r<n>`).
    expect(sent?.MessageDeduplicationId).toMatch(new RegExp(`^${REQUEST_ID}-redrive-\\d+$`));
    expect(sent?.MessageDeduplicationId).not.toBe(REQUEST_ID);
    expect(sent?.MessageDeduplicationId).not.toMatch(/-r\d+$/);
    expect(sent?.MessageSystemAttributes).toEqual({ AWSTraceHeader: { DataType: "String", StringValue: traceHeader } });

    const deleteCalls = sqs.commandCalls(DeleteMessageCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.args[0].input).toEqual({ QueueUrl: DLQ_URL, ReceiptHandle: "receipt-1" });

    // Order matters: the send must be recorded before the delete.
    const allCalls = sqs.calls();
    const sendIndex = allCalls.findIndex((call) => call.args[0] instanceof SendMessageCommand);
    const deleteIndex = allCalls.findIndex((call) => call.args[0] instanceof DeleteMessageCommand);
    expect(sendIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(sendIndex);
  });

  it("sends no MessageSystemAttributes field when the received message carried no AWSTraceHeader", async () => {
    sqs.on(ReceiveMessageCommand).resolves({ Messages: [dlqMessage()] }); // no AWSTraceHeader
    ddb.on(GetCommand).resolves({ Item: { status: "failed" } });
    sqs.on(SendMessageCommand).resolves({});
    sqs.on(DeleteMessageCommand).resolves({});

    await script.redrive(sqsClient, ddbClient, config, "msg-1");

    expect(sqs.commandCalls(SendMessageCommand)[0]?.args[0].input).not.toHaveProperty("MessageSystemAttributes");
  });

  it("does not send or delete, and exits 1, when the body is malformed", async () => {
    sqs.on(ReceiveMessageCommand).resolves({ Messages: [dlqMessage({ Body: "{not json" })] });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await script.redrive(sqsClient, ddbClient, config, "msg-1");

    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(sqs.commandCalls(DeleteMessageCommand)).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    expect(loggedLines(err)).toContain("malformed");
  });

  it("does not send or delete, and exits 1, when the request no longer exists", async () => {
    sqs.on(ReceiveMessageCommand).resolves({ Messages: [dlqMessage()] });
    ddb.on(GetCommand).resolves({});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await script.redrive(sqsClient, ddbClient, config, "msg-1");

    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(sqs.commandCalls(DeleteMessageCommand)).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    expect(loggedLines(err)).toContain("no longer exists");
  });

  it("does not send or delete, and exits 1, when the id is not in the batch", async () => {
    sqs.on(ReceiveMessageCommand).resolves({ Messages: [dlqMessage({ MessageId: "other-id" })] });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await script.redrive(sqsClient, ddbClient, config, "msg-1");

    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(sqs.commandCalls(DeleteMessageCommand)).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    expect(loggedLines(err)).toContain("run `list` again");
  });

  it("does not delete when the send throws, and exits 1", async () => {
    sqs.on(ReceiveMessageCommand).resolves({ Messages: [dlqMessage()] });
    ddb.on(GetCommand).resolves({ Item: { status: "failed" } });
    sqs.on(SendMessageCommand).rejects(new Error("Throttled"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await script.redrive(sqsClient, ddbClient, config, "msg-1");

    expect(sqs.commandCalls(DeleteMessageCommand)).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    expect(loggedLines(err)).toContain("Throttled");
  });
});

describe("discard", () => {
  it("deletes the matched message and never sends", async () => {
    sqs.on(ReceiveMessageCommand).resolves({ Messages: [dlqMessage()] });
    sqs.on(DeleteMessageCommand).resolves({});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await script.discard(sqsClient, { dlqUrl: DLQ_URL }, "msg-1");

    const deleteCalls = sqs.commandCalls(DeleteMessageCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.args[0].input).toEqual({ QueueUrl: DLQ_URL, ReceiptHandle: "receipt-1" });
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
    expect(loggedLines(log)).toContain("discarded msg-1");
  });

  it("refuses (no delete), and exits 1, when the id is not found", async () => {
    sqs.on(ReceiveMessageCommand).resolves({ Messages: [] });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await script.discard(sqsClient, { dlqUrl: DLQ_URL }, "missing-id");

    expect(sqs.commandCalls(DeleteMessageCommand)).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    expect(loggedLines(err)).toContain("run `list` again");
  });
});

// What keeps the duplication in backend/scripts/redrive-dlq.mjs honest: if the real domain
// logic ever changes, this test starts failing instead of the two copies silently drifting apart.
describe("duplicated domain logic stays in sync with src/domain/", () => {
  it("MESSAGE_GROUP_ID agrees with the real one", () => {
    expect(script.MESSAGE_GROUP_ID).toBe(MESSAGE_GROUP_ID_REAL);
  });

  it("ownerKey and requestKey agree with the real ones for several ids", () => {
    for (const id of ["user-a", REQUEST_ID, "u2", "owner with spaces"]) {
      expect(script.ownerKey(id)).toBe(ownerKeyReal(id));
      expect(script.requestKey(id)).toBe(requestKeyReal(id));
    }
  });

  it("decodeDeliveryMessage agrees with the real one for a decodable body", () => {
    const body = JSON.stringify({ requestId: REQUEST_ID, ownerId: "user-a" });
    expect(script.decodeDeliveryMessage(body)).toEqual(decodeDeliveryMessageReal(body));
  });

  it("decodeDeliveryMessage agrees with the real one for an undecodable body", () => {
    for (const body of ["{not json", "{}", '{"requestId":""}', '{"requestId":"r1","ownerId":123}', "[]"]) {
      expect(script.decodeDeliveryMessage(body)).toEqual(decodeDeliveryMessageReal(body));
    }
  });
});
