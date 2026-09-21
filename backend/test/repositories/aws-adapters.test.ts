import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sent } from "../helpers/sqs";
import type { Exchange } from "../../src/domain/exchange";
import { S3ExchangeStore } from "../../src/repositories/s3-exchange-store";
import { S3LogArchiveStore } from "../../src/repositories/s3-log-archive-store";
import { SnsStatusNotifier } from "../../src/repositories/sns-status-notifier";
import { SqsDeliveryQueue } from "../../src/repositories/sqs-delivery-queue";

// The small adapters that call SQS, SNS and S3. The tests pin down the exact commands,
// because a wrong field would only show up against the real services.
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

describe("S3ExchangeStore", () => {
  const store = new S3ExchangeStore(new S3Client({}), "demo-dev-deliveries-000000000000");
  const exchange: Exchange = {
    attempt: 2,
    at: "2026-09-21T10:00:00.000Z",
    outcome: "delivered",
    request: { xml: "<Submission/>", valid: true, problems: [] },
    reply: { httpStatus: 200, xml: "<Reply/>", valid: true, status: "Accepted" },
  };
  // What the SDK gives back for an object: a body with `transformToString`.
  const object = (text: string) => ({ Body: { transformToString: () => Promise.resolve(text) } as never });
  const denied = () => new S3ServiceException({ name: "AccessDenied", $fault: "client", $metadata: { httpStatusCode: 403 } });

  describe("save", () => {
    it("puts the exchange as JSON at exchanges/<requestId>.json", async () => {
      s3.on(PutObjectCommand).resolves({});

      await store.save("r1", exchange);

      const calls = s3.commandCalls(PutObjectCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]?.args[0].input;
      expect(input?.Bucket).toBe("demo-dev-deliveries-000000000000");
      expect(input?.Key).toBe("exchanges/r1.json");
      expect(input?.ContentType).toBe("application/json; charset=utf-8");
      expect(JSON.parse(input?.Body as string) as unknown).toEqual(exchange);
      // Encryption comes from the bucket's default: the code asks for nothing special.
      expect(input).not.toHaveProperty("ServerSideEncryption");
    });

    it("keeps a reply of null as null", async () => {
      s3.on(PutObjectCommand).resolves({});

      await store.save("r1", { ...exchange, outcome: "retry", reply: null });

      expect(JSON.parse(s3.commandCalls(PutObjectCommand)[0]?.args[0].input.Body as string)).toMatchObject({ reply: null });
    });

    it("lets failures reach the caller", async () => {
      s3.on(PutObjectCommand).rejects(new Error("AccessDenied"));

      await expect(store.save("r1", exchange)).rejects.toThrow("AccessDenied");
    });
  });

  describe("find", () => {
    it("reads the object of that request and returns the exchange", async () => {
      s3.on(GetObjectCommand).resolves(object(JSON.stringify(exchange)));

      expect(await store.find("r1")).toEqual(exchange);

      expect(s3.commandCalls(GetObjectCommand)[0]?.args[0].input).toEqual({
        Bucket: "demo-dev-deliveries-000000000000",
        Key: "exchanges/r1.json",
      });
    });

    it("returns undefined for NoSuchKey, and only for that", async () => {
      s3.on(GetObjectCommand).rejects(new NoSuchKey({ message: "no such key", $metadata: {} }));

      expect(await store.find("r1")).toBeUndefined();
    });

    it("throws AccessDenied: a missing permission must not look like 'no delivery attempt yet'", async () => {
      s3.on(GetObjectCommand).rejects(denied());

      await expect(store.find("r1")).rejects.toMatchObject({ name: "AccessDenied" });
    });

    it("throws every other failure too", async () => {
      s3.on(GetObjectCommand).rejects(new Error("connection reset"));

      await expect(store.find("r1")).rejects.toThrow("connection reset");
    });

    it("throws when the stored object does not have the shape of an exchange, naming the fields and not the content", async () => {
      const broken = { ...exchange, outcome: "SECRET-value", request: { xml: 42 } };
      s3.on(GetObjectCommand).resolves(object(JSON.stringify(broken)));

      const failure = store.find("r1");

      await expect(failure).rejects.toThrow(/does not match the expected shape \(outcome, request\.xml/);
      await expect(failure).rejects.not.toThrow(/SECRET-value/);
    });

    it("throws a fixed message when the object is not JSON: the parser's own message quotes the text", async () => {
      s3.on(GetObjectCommand).resolves(object("{ secret request text"));

      const failure = store.find("r1");

      await expect(failure).rejects.toThrow("The stored exchange is not valid JSON");
      await expect(failure).rejects.not.toThrow(/secret request text/);
    });

    it("throws for an object without a body", async () => {
      s3.on(GetObjectCommand).resolves({});

      await expect(store.find("r1")).rejects.toThrow("not valid JSON");
    });
  });
});

describe("S3LogArchiveStore", () => {
  const store = new S3LogArchiveStore(new S3Client({}), "demo-dev-log-archive-000000000000");
  const key = "logs/year=2026/month=09/day=21/c834ea32c452075ffc64a1eb394b60dd.json.gz";

  it("puts the bytes at the given key of its bucket", async () => {
    s3.on(PutObjectCommand).resolves({});
    const body = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);

    await store.put(key, body);

    const calls = s3.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]?.args[0].input;
    expect(input?.Bucket).toBe("demo-dev-log-archive-000000000000");
    expect(input?.Key).toBe(key);
    expect(input?.Body).toBe(body);
    expect(input?.ContentType).toBe("application/json");
  });

  it("sets no ContentEncoding (Athena reads the compression from the .gz name) and no encryption (the bucket's default applies)", async () => {
    s3.on(PutObjectCommand).resolves({});

    await store.put(key, new Uint8Array([1]));

    const input = s3.commandCalls(PutObjectCommand)[0]?.args[0].input;
    expect(input).not.toHaveProperty("ContentEncoding");
    expect(input).not.toHaveProperty("ServerSideEncryption");
  });

  it("lets failures reach the caller", async () => {
    s3.on(PutObjectCommand).rejects(new Error("SlowDown"));

    await expect(store.put(key, new Uint8Array([1]))).rejects.toThrow("SlowDown");
  });
});
