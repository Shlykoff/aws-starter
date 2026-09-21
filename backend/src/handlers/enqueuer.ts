import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { Context, DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { container } from "../container-enqueuer";
import { newRequestImageSchema } from "../domain/request-image";
import type { Logger } from "../lib/logger";
import type { EnqueueEntry, EnqueueService } from "../services/enqueue-service";
import { TOKENS } from "../tokens";

// The DynamoDB stream of the requests table: every new request, and every request the owner
// sends again, goes onto the SQS queue (docs/api.md, "Delivery pipeline"). Resolved once at
// module scope (see create-request.ts).
const service = container.get<EnqueueService>(TOKENS.EnqueueService);
const logger = container.get<Logger>(TOKENS.Logger);

type ParsedRecord = { entry: EnqueueEntry } | { skipReason: string; invalidFields?: string[] };

// Is this stream record for the queue? Two kinds are:
//   - INSERT: a new request;
//   - MODIFY of a request sent again: the new image has status `created` and a numeric
//     `retryCount` (the API set both in one update). Only the new image is in the stream, so
//     "it was failed before" cannot be tested; `created` with a `retryCount` is the state of a
//     request sent again, and a stray record of that state is harmless: the queue drops the
//     message (same deduplication id) and the worker skips a finished request.
// Every other MODIFY (a status change of the pipeline, a stored decision) and every REMOVE is
// not. This is the same test as the filter of the event source mapping (infra), on the raw
// record (DynamoDB's typed format: `{ S: "created" }`, `{ N: "1" }`).
function isForTheQueue(record: DynamoDBRecord): boolean {
  if (record.eventName === "INSERT") return true;
  if (record.eventName !== "MODIFY") return false;

  const image = record.dynamodb?.NewImage;
  return image?.status?.S === "created" && image.retryCount?.N !== undefined;
}

// Turns one stream record into an entry for the service, or says why it cannot be used.
// It never returns or logs the image itself: it holds the request text.
function parseRecord(record: DynamoDBRecord): ParsedRecord {
  const sequenceNumber = record.dynamodb?.SequenceNumber;
  const image = record.dynamodb?.NewImage;
  if (sequenceNumber === undefined) return { skipReason: "no_sequence_number" };
  if (image === undefined) return { skipReason: "no_new_image" };

  let item: unknown;
  try {
    // The stream delivers DynamoDB's typed format ({ S: "..." }); unmarshall makes it a
    // plain object. (The two AttributeValue types differ only in how strictly they are
    // written, hence the cast.)
    item = unmarshall(image as Record<string, AttributeValue>);
  } catch {
    return { skipReason: "image_not_readable" };
  }

  const parsed = newRequestImageSchema.safeParse(item);
  if (!parsed.success) {
    // Only the names of the invalid fields are reported, never their values.
    const invalidFields = parsed.error.issues.map((issue) => issue.path.join("."));
    return { skipReason: "invalid_image_fields", invalidFields };
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
    // The event source mapping already applies the same filter. Checking again costs nothing
    // and protects against a mapping that was changed by hand: a status update of the
    // pipeline must never enqueue a request a second time.
    if (!isForTheQueue(record)) {
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
        invalidFields: parsed.invalidFields,
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
