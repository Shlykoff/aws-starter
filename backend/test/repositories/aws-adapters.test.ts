import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sent } from "../helpers/sqs";
import { S3AuditStore } from "../../src/repositories/s3-audit-store";
import { SnsStatusNotifier } from "../../src/repositories/sns-status-notifier";
import { SqsDeliveryQueue } from "../../src/repositories/sqs-delivery-queue";

// The three small adapters that call SQS, SNS and S3. The tests pin down the exact
// commands, because a wrong field would only show up against the real services.
const sqs = mockClient(SQSClient);
const sns = mockClient(SNSClient);
const s3 = mockClient(S3Client);

afterEach(() => {
  sqs.reset();
  sns.reset();
  s3.reset();
});
afterAll(() => {
  sqs.restore();
  sns.restore();
  s3.restore();
});

const QUEUE_URL = "https://sqs.eu-north-1.amazonaws.com/000000000000/demo-dev-deliveries.fifo";

describe("SqsDeliveryQueue", () => {
  const queue = new SqsDeliveryQueue(new SQSClient({}), QUEUE_URL);
  const messages = [
    { id: "seq-1", body: '{"requestId":"r1","ownerId":"o"}', groupId: "g1", deduplicationId: "r1" },
    { id: "seq-2", body: '{"requestId":"r2","ownerId":"o"}', groupId: "g2", deduplicationId: "r2" },
  ];

  it("sends one SendMessageBatch with group and deduplication ids", async () => {
    sqs.on(SendMessageBatchCommand).resolves({ Successful: [], Failed: [] });

    await queue.sendBatch(messages);

    const calls = sqs.commandCalls(SendMessageBatchCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({
      QueueUrl: QUEUE_URL,
      Entries: [
        { Id: "seq-1", MessageBody: messages[0]?.body, MessageGroupId: "g1", MessageDeduplicationId: "r1" },
        { Id: "seq-2", MessageBody: messages[1]?.body, MessageGroupId: "g2", MessageDeduplicationId: "r2" },
      ],
    });
  });

  it("returns no failed ids when SQS accepted everything", async () => {
    sqs.on(SendMessageBatchCommand).resolves({ Successful: [sent("seq-1"), sent("seq-2")] });

    expect(await queue.sendBatch(messages)).toEqual([]);
  });

  it("returns the ids SQS refused, even though the call itself succeeded", async () => {
    sqs.on(SendMessageBatchCommand).resolves({
      Successful: [sent("seq-1")],
      Failed: [{ Id: "seq-2", Code: "InternalError", SenderFault: false }],
    });

    expect(await queue.sendBatch(messages)).toEqual(["seq-2"]);
  });

  it("lets a failure of the whole call reach the caller", async () => {
    sqs.on(SendMessageBatchCommand).rejects(new Error("AccessDenied"));

    await expect(queue.sendBatch(messages)).rejects.toThrow("AccessDenied");
  });
});

describe("SnsStatusNotifier", () => {
  const notifier = new SnsStatusNotifier(
    new SNSClient({}),
    "arn:aws:sns:eu-north-1:000000000000:demo-dev-request-status",
  );

  it("publishes {requestId, status, at} with the status as a message attribute", async () => {
    sns.on(PublishCommand).resolves({});

    await notifier.publish({ requestId: "r1", status: "rejected", at: "2026-09-21T10:00:00.000Z" });

    const calls = sns.commandCalls(PublishCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({
      TopicArn: "arn:aws:sns:eu-north-1:000000000000:demo-dev-request-status",
      Message: '{"requestId":"r1","status":"rejected","at":"2026-09-21T10:00:00.000Z"}',
      MessageAttributes: { status: { DataType: "String", StringValue: "rejected" } },
    });
  });

  it("lets failures reach the caller", async () => {
    sns.on(PublishCommand).rejects(new Error("throttled"));

    await expect(
      notifier.publish({ requestId: "r1", status: "sent", at: "2026-09-21T10:00:00.000Z" }),
    ).rejects.toThrow("throttled");
  });
});

describe("S3AuditStore", () => {
  const store = new S3AuditStore(new S3Client({}), "demo-dev-deliveries-000000000000");
  const copy = {
    sentAt: "2026-09-21T10:00:00.000Z",
    payload: {
      id: "r1",
      partner: "Acme",
      subject: "Order 42",
      body: "Please ship.",
      createdAt: "2026-09-21T09:00:00.000Z",
    },
    partnerStatus: 200,
  };

  it("puts { sentAt, payload, partnerStatus } at deliveries/<requestId>.json", async () => {
    s3.on(PutObjectCommand).resolves({});

    await store.save("r1", copy);

    const calls = s3.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]?.args[0].input;
    expect(input?.Bucket).toBe("demo-dev-deliveries-000000000000");
    expect(input?.Key).toBe("deliveries/r1.json");
    expect(input?.ContentType).toBe("application/json");
    expect(JSON.parse(input?.Body as string) as unknown).toEqual(copy);
  });

  it("lets failures reach the caller", async () => {
    s3.on(PutObjectCommand).rejects(new Error("AccessDenied"));

    await expect(store.save("r1", copy)).rejects.toThrow("AccessDenied");
  });
});
