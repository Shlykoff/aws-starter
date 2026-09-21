import type {
  AttributeValue,
  DynamoDBRecord,
  DynamoDBStreamEvent,
  SQSEvent,
  SQSRecord,
} from "aws-lambda";

// Builders for the events of the delivery pipeline. Fake values: only the fields the code
// under test reads matter; the rest only makes the object a valid event.

/** A stream record for a stored request, in DynamoDB's typed format ({ S: "..." }). */
export function streamRecord(options: {
  eventName?: "INSERT" | "MODIFY" | "REMOVE";
  sequenceNumber: string;
  ownerId?: string;
  id?: string;
  partner?: string;
  subject?: string;
  body?: string;
  /** The status in the image (default "created"). */
  status?: string;
  /** Adds `retryCount` to the image: the request has been sent again this many times. */
  retryCount?: number;
  /** Replaces the whole image, for malformed records. */
  image?: Record<string, AttributeValue>;
}): DynamoDBRecord {
  const id = options.id ?? "01J8Z3K5W0ABCDEFGHJKMNPQR1";
  return {
    eventID: `event-${options.sequenceNumber}`,
    eventName: options.eventName ?? "INSERT",
    eventSource: "aws:dynamodb",
    dynamodb: {
      SequenceNumber: options.sequenceNumber,
      StreamViewType: "NEW_IMAGE",
      NewImage: options.image ?? {
        pk: { S: `USER#${options.ownerId ?? "user-a"}` },
        sk: { S: `REQ#${id}` },
        id: { S: id },
        partner: { S: options.partner ?? "Acme" },
        subject: { S: options.subject ?? "Order 42" },
        body: { S: options.body ?? "Please ship." },
        status: { S: options.status ?? "created" },
        createdAt: { S: "2026-09-21T09:00:00.000Z" },
        ...(options.retryCount !== undefined && { retryCount: { N: String(options.retryCount) } }),
      },
    },
  };
}

export const streamEvent = (...records: DynamoDBRecord[]): DynamoDBStreamEvent => ({ Records: records });

/** An SQS record of the deliveries queue. */
export function sqsRecord(options: {
  messageId: string;
  requestId?: string;
  ownerId?: string;
  /** Replaces the JSON body, for malformed messages. */
  body?: string;
  receiveCount?: number;
}): SQSRecord {
  return {
    messageId: options.messageId,
    receiptHandle: `handle-${options.messageId}`,
    body:
      options.body ??
      JSON.stringify({
        requestId: options.requestId ?? "01J8Z3K5W0ABCDEFGHJKMNPQR1",
        ownerId: options.ownerId ?? "user-a",
      }),
    attributes: {
      ApproximateReceiveCount: String(options.receiveCount ?? 1),
      SentTimestamp: "1789984800000",
      SenderId: "test-sender",
      ApproximateFirstReceiveTimestamp: "1789984800100",
    },
    messageAttributes: {},
    md5OfBody: "not-checked",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:eu-north-1:000000000000:test-deliveries.fifo",
    awsRegion: "eu-north-1",
  };
}

export const sqsEvent = (...records: SQSRecord[]): SQSEvent => ({ Records: records });
