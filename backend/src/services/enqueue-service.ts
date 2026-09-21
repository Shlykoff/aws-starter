import { deduplicationId, encodeDeliveryMessage, messageGroupId } from "../domain/delivery-message";
import type { EnqueueRequest } from "../domain/request-image";
import { describeError } from "../lib/errors";
import type { Logger } from "../lib/logger";
import type { DeliveryQueue, QueueMessage } from "../repositories/delivery-queue";
import type { DeliveryRepository } from "../repositories/delivery-repository";

// SendMessageBatch accepts at most 10 messages per call.
const MAX_MESSAGES_PER_CALL = 10;

export interface EnqueueEntry {
  /**
   * Identifies the entry to the caller: the handler uses the sequence number of the stream
   * record. The service only hands the keys of the failed entries back.
   */
  key: string;
  request: EnqueueRequest;
}

export interface EnqueueResult {
  /** Entries that must be tried again. */
  failedKeys: string[];
  /** Messages SQS accepted. */
  sent: number;
  /** Requests this call moved from "created" to "queued". */
  queued: number;
  /** Requests that were no longer "created" (somebody else moved them on first). */
  alreadyMoved: number;
}

// Step 1 of the delivery pipeline (docs/api.md): a stored request goes onto the queue, and so
// does one that the owner has sent again (the same steps, another deduplication id).
//
// For every request: send the message, THEN mark the request as queued. If we crash or the
// update fails after sending, the whole stream record is retried and the message is sent a
// second time. That is safe: the queue deduplicates by its deduplication id (for 5 minutes) and the
// worker ignores a request that is already finished. The other order could lose a request
// (marked queued, never sent), so it is not used.
export class EnqueueService {
  constructor(
    private readonly queue: DeliveryQueue,
    private readonly repository: DeliveryRepository,
  ) {}

  async enqueue(entries: EnqueueEntry[], log: Logger): Promise<EnqueueResult> {
    const result: EnqueueResult = { failedKeys: [], sent: 0, queued: 0, alreadyMoved: 0 };

    for (let start = 0; start < entries.length; start += MAX_MESSAGES_PER_CALL) {
      const chunk = entries.slice(start, start + MAX_MESSAGES_PER_CALL);
      const refused = await this.send(chunk, log);

      for (const entry of chunk) {
        if (refused.has(entry.key)) {
          result.failedKeys.push(entry.key);
          continue;
        }
        result.sent += 1;

        try {
          const applied = await this.repository.markQueued(entry.request.ownerId, entry.request.requestId);
          if (applied) result.queued += 1;
          else result.alreadyMoved += 1; // not an error: the worker was faster
        } catch (error) {
          log.error("Could not mark the request as queued", {
            requestId: entry.request.requestId,
            ...describeError(error),
          });
          result.failedKeys.push(entry.key);
        }
      }
    }
    return result;
  }

  // One SendMessageBatch call. Returns the keys of the entries that were NOT accepted:
  // the ones SQS refused, or all of them when the call itself failed.
  private async send(chunk: EnqueueEntry[], log: Logger): Promise<Set<string>> {
    const messages: QueueMessage[] = chunk.map(({ key, request }) => ({
      id: key,
      body: encodeDeliveryMessage({ requestId: request.requestId, ownerId: request.ownerId }),
      groupId: messageGroupId(request.partner),
      // The request id is the deduplication id (plus the retry number for a request sent
      // again), so a message sent twice is delivered once. (Content-based deduplication is
      // off: the body is only two ids.)
      deduplicationId: deduplicationId(request.requestId, request.retryCount),
    }));

    try {
      return new Set(await this.queue.sendBatch(messages));
    } catch (error) {
      log.error("SendMessageBatch failed", { messages: messages.length, ...describeError(error) });
      return new Set(chunk.map((entry) => entry.key));
    }
  }
}
