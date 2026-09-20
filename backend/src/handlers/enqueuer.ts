import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { Context, DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { container } from "../container-enqueuer";
import { newRequestImageSchema } from "../domain/request-image";
import type { Logger } from "../lib/logger";
import type { EnqueueEntry, EnqueueService } from "../services/enqueue-service";
import { TOKENS } from "../tokens";

// The DynamoDB stream of the requests table: every new request goes onto the SQS queue
// (docs/api.md, "Delivery pipeline"). Resolved once at module scope (see create-request.ts).
const service = container.get<EnqueueService>(TOKENS.EnqueueService);
const logger = container.get<Logger>(TOKENS.Logger);

type ParsedRecord = { entry: EnqueueEntry } | { skipReason: string };

// Turns one stream record into an entry for the service, or says why it cannot be used.
// It never returns or logs the image itself: it holds the request text.
function parseRecord(record: DynamoDBRecord): ParsedRecord {
  const sequenceNumber = record.dynamodb?.SequenceNumber;
  const image = record.dynamodb?.NewImage;
  if (sequenceNumber === undefined) return { skipReason: "record has no sequence number" };
  if (image === undefined) return { skipReason: "record has no NewImage" };

  let item: unknown;
  try {
    // The stream delivers DynamoDB's typed format ({ S: "..." }); unmarshall makes it a
    // plain object. (The two AttributeValue types differ only in how strictly they are
    // written, hence the cast.)
    item = unmarshall(image as Record<string, AttributeValue>);
  } catch {
    return { skipReason: "NewImage could not be unmarshalled" };
  }

  const parsed = newRequestImageSchema.safeParse(item);
  if (!parsed.success) {
    // Only the names of the invalid fields are reported, never their values.
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    return { skipReason: `invalid NewImage fields: ${fields}` };
  }
  return { entry: { key: sequenceNumber, request: parsed.data } };
}

export const handler = async (
  event: DynamoDBStreamEvent,
  context: Context,
): Promise<DynamoDBBatchResponse> => {
  const log = logger.child({ awsRequestId: context.awsRequestId });

  const entries: EnqueueEntry[] = [];
  let ignored = 0;
  let malformed = 0;

  for (const record of event.Records) {
    // The event source mapping already filters for INSERT. Checking again costs nothing and
    // protects against a mapping that was changed by hand: an update record must never
    // enqueue a request a second time.
    if (record.eventName !== "INSERT") {
      ignored += 1;
      continue;
    }

    const parsed = parseRecord(record);
    if ("entry" in parsed) {
      entries.push(parsed.entry);
    } else {
      // A record that can never work is skipped, not reported: reporting it would make
      // Lambda retry the same broken record until it expires. It is logged, so it is seen.
      malformed += 1;
      log.error("Skipping a malformed stream record", {
        sequenceNumber: record.dynamodb?.SequenceNumber,
        reason: parsed.skipReason,
      });
    }
  }

  const result = await service.enqueue(entries, log);

  log.info("Stream batch handled", {
    records: event.Records.length,
    ignored,
    malformed,
    sent: result.sent,
    queued: result.queued,
    alreadyMoved: result.alreadyMoved,
    failed: result.failedKeys.length,
  });

  // ReportBatchItemFailures: Lambda retries from the first record reported here.
  return { batchItemFailures: result.failedKeys.map((itemIdentifier) => ({ itemIdentifier })) };
};
