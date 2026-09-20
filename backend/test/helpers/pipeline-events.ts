import type {
  AttributeValue,
  DynamoDBRecord,
  DynamoDBStreamEvent,
  LambdaFunctionURLEvent,
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
        status: { S: "created" },
        createdAt: { S: "2026-09-21T09:00:00.000Z" },
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

/** A Lambda Function URL event (payload format 2.0) as the partner mock receives it. */
export function functionUrlEvent(options: {
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string>;
}): LambdaFunctionURLEvent {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/",
    rawQueryString: "",
    headers: { "content-type": "application/json", ...options.headers },
    requestContext: {
      accountId: "test-account",
      apiId: "test-url-id",
      domainName: "test-url-id.lambda-url.eu-north-1.on.aws",
      domainPrefix: "test-url-id",
      http: {
        method: "POST",
        path: "/",
        protocol: "HTTP/1.1",
        sourceIp: "192.0.2.1",
        userAgent: "vitest",
      },
      requestId: "test-gateway-request-id",
      routeKey: "$default",
      stage: "$default",
      time: "21/Sep/2026:10:00:00 +0000",
      timeEpoch: 1789984800000,
    },
    body: options.body,
    isBase64Encoded: options.isBase64Encoded ?? false,
  };
}
