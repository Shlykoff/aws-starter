import { deduplicationId, encodeDeliveryMessage, messageGroupId } from "../domain/delivery-message";
import type { EnqueueRequest } from "../domain/request-image";
import { describeError } from "../lib/errors";
import type { Logger } from "../lib/logger";
import { logRequestEvent } from "../lib/request-events";
import { contextFromTraceparent, startSpan, toXRayTraceHeader } from "../lib/tracing";
import type { OpenSpan } from "../lib/tracing";
import type { DeliveryQueue, QueueMessage } from "../repositories/delivery-queue";
import type { DeliveryRepository } from "../repositories/delivery-repository";

// SendMessageBatch accepts at most 10 messages per call.
const MAX_MESSAGES_PER_CALL = 10;

// An entry with its span: the span belongs to the request and lives as long as this service works on it.
interface TracedEntry {
  entry: EnqueueEntry;
  span: OpenSpan;
}

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
      // One span `enqueue request` per request, in the trace stored with the request (the stream
      // carries none; without a stored trace the span simply belongs to this invocation's). The
      // spans are opened BEFORE the send, because the message carries the trace that the worker
      // continues, and they stay open until each request is marked: the batch is one SQS call, so
      // a span cannot be a callback around it (`withSpan`).
      const chunk: TracedEntry[] = [];
      try {
        for (const entry of entries.slice(start, start + MAX_MESSAGES_PER_CALL)) {
          const span = startSpan(
            "enqueue request",
            { requestId: entry.request.requestId },
            { parent: contextFromTraceparent(entry.request.traceparent) },
          );
          chunk.push({ entry, span });
        }
        const refused = await this.send(chunk, log);

        for (const traced of chunk) {
          if (refused.has(traced.entry.key)) {
            result.failedKeys.push(traced.entry.key);
            traced.span.setAttributes({ outcome: "send_failed" });
            continue;
          }
          result.sent += 1;
          // In the request's trace, so that the update of the table is one of its spans too.
          await traced.span.run(() => this.markAsQueued(traced, result, log));
        }
      } finally {
        for (const { span } of chunk) span.end();
      }
    }
    return result;
  }

  // The second half of an entry: mark the request as queued, if nobody has moved it on.
  private async markAsQueued({ entry, span }: TracedEntry, result: EnqueueResult, log: Logger): Promise<void> {
    try {
      const applied = await this.repository.markQueued(entry.request.ownerId, entry.request.requestId);
      if (applied) {
        result.queued += 1;
        span.setAttributes({ outcome: "queued" });
        // Only when this call moved it: not when the worker was faster (below).
        logRequestEvent(log, {
          event: "request_queued",
          role: "enqueuer",
          requestId: entry.request.requestId,
          fromStatus: "created",
          toStatus: "queued",
        });
      } else {
        result.alreadyMoved += 1; // not an error: the worker was faster
        span.setAttributes({ outcome: "already_moved" });
      }
    } catch (error) {
      log.error("Could not mark the request as queued", {
        requestId: entry.request.requestId,
        ...describeError(error),
      });
      span.setAttributes({ outcome: "mark_failed" });
      span.fail(error);
      result.failedKeys.push(entry.key);
    }
  }

  // One SendMessageBatch call. Returns the keys of the entries that were NOT accepted:
  // the ones SQS refused, or all of them when the call itself failed.
  private async send(chunk: TracedEntry[], log: Logger): Promise<Set<string>> {
    const messages: QueueMessage[] = chunk.map(({ entry: { key, request }, span }) => {
      const traceHeader = toXRayTraceHeader(span.traceparent);
      return {
        id: key,
        body: encodeDeliveryMessage({ requestId: request.requestId, ownerId: request.ownerId }),
        groupId: messageGroupId(request.partner),
        // The request id is the deduplication id (plus the retry number for a request sent
        // again), so a message sent twice is delivered once. (Content-based deduplication is
        // off: the body is only two ids.)
        deduplicationId: deduplicationId(request.requestId, request.retryCount),
        // The trace of this request, so that the worker's invocation joins it (only when there is one).
        ...(traceHeader !== undefined && { traceHeader }),
      };
    });

    try {
      return new Set(await this.queue.sendBatch(messages));
    } catch (error) {
      log.error("SendMessageBatch failed", { messages: messages.length, ...describeError(error) });
      for (const { span } of chunk) {
        span.setAttributes({ outcome: "send_failed" });
        span.fail(error);
      }
      return new Set(chunk.map(({ entry }) => entry.key));
    }
  }
}
