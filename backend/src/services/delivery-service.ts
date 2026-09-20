import { decodeDeliveryMessage } from "../domain/delivery-message";
import type { DeliveryMessage } from "../domain/delivery-message";
import { toPartnerPayload } from "../domain/partner-payload";
import type { PartnerPayload } from "../domain/partner-payload";
import { isTerminal } from "../domain/request-status";
import type { TerminalStatus } from "../domain/request-status";
import type { PartnerClient } from "../clients/partner-client";
import { describeError } from "../lib/errors";
import type { Logger } from "../lib/logger";
import type { AuditStore } from "../repositories/audit-store";
import type { DeliveryRepository } from "../repositories/delivery-repository";
import type { StatusNotifier } from "../repositories/status-notifier";

/** One SQS message, as plain values (the handler maps the SQS record to this). */
export interface DeliveryJob {
  messageId: string;
  body: string;
  /** How many times SQS has handed this message out, this delivery included (starts at 1). */
  receiveCount: number;
}

// What happened to one message. The first three acknowledge the message (SQS deletes it);
// the others report it as failed, so SQS hands it out again or moves it to the DLQ.
export type DeliveryOutcome =
  | "sent" // the partner accepted it; status "sent"
  | "rejected" // the partner refused it for good; status "rejected"
  | "alreadyDone" // it was finished before (or a parallel run finished it): nothing to do
  | "retry" // the partner could not take it now; SQS will hand it out again
  | "failed" // last attempt: status "failed" written, SQS moves the message to the DLQ
  | "error" // something on our side broke (DynamoDB, S3, a bug); SQS will hand it out again
  | "undeliverable" // a malformed message or an unknown request; goes to the DLQ in the end
  | "notAttempted"; // an earlier message of the batch failed, so this one was not tried

const ACKNOWLEDGED: readonly DeliveryOutcome[] = ["sent", "rejected", "alreadyDone"];

export type DeliveryCounts = Record<DeliveryOutcome, number>;

export interface DeliveryResult {
  /** The messages to report as failed: the first failure and every message after it. */
  failedMessageIds: string[];
  counts: DeliveryCounts;
}

// Step 2 of the pipeline (docs/api.md, "delivery-worker"): take a queued request, hand it
// to the partner, record the result.
//
// The queue may deliver the same message twice, and this code may die half-way. So every
// step is safe to repeat: a finished request is skipped, the partner deduplicates by
// Idempotency-Key, the S3 copy is overwritten and status changes are conditional.
export class DeliveryService {
  constructor(
    private readonly repository: DeliveryRepository,
    private readonly partner: PartnerClient,
    private readonly audit: AuditStore,
    private readonly notifier: StatusNotifier,
    // The queue's maxReceiveCount: the receive on which SQS gives up and moves the message
    // to the DLQ. Terraform passes the same number to the queue and to this function.
    private readonly maxReceiveCount: number,
    // A parameter only so that tests can fix the clock.
    private readonly now: () => Date = () => new Date(),
  ) {}

  async deliver(jobs: DeliveryJob[], log: Logger): Promise<DeliveryResult> {
    const counts: DeliveryCounts = {
      sent: 0,
      rejected: 0,
      alreadyDone: 0,
      retry: 0,
      failed: 0,
      error: 0,
      undeliverable: 0,
      notAttempted: 0,
    };
    const failedMessageIds: string[] = [];

    // Stop at the first failure. The queue is FIFO: if message 2 failed, message 3 (which
    // may belong to the same partner) must not be delivered before message 2 is. So the
    // failed message and everything after it go back to the queue, untouched.
    let stopped = false;
    for (const job of jobs) {
      const outcome = stopped ? "notAttempted" : await this.deliverOne(job, log);
      counts[outcome] += 1;

      if (!ACKNOWLEDGED.includes(outcome)) {
        failedMessageIds.push(job.messageId);
        stopped = true;
      }
    }
    return { failedMessageIds, counts };
  }

  private async deliverOne(job: DeliveryJob, log: Logger): Promise<DeliveryOutcome> {
    const message = decodeDeliveryMessage(job.body);
    if (message === undefined) {
      // Our own enqueuer wrote this message, so a malformed body is a bug. It can never
      // succeed, but it is not thrown away either: after maxReceiveCount receives it lands
      // in the DLQ, where the alarm and a person can look at it. (The body is not logged.)
      log.error("Queue message is malformed", { messageId: job.messageId });
      return "undeliverable";
    }

    const messageLog = log.child({ requestId: message.requestId });
    try {
      return await this.process(message, job.receiveCount, messageLog);
    } catch (error) {
      // Anything unexpected: DynamoDB or S3 unavailable, missing permissions, a bug. The
      // message is reported as failed and comes back later. This deliberately does NOT
      // write "failed" on the last attempt: the database may be the very thing that broke,
      // and if the partner had already accepted the request, "failed" would be wrong. The
      // message then sits in the DLQ (the alarm fires) and the request keeps its status.
      // docs/api.md lists this as a known limit.
      messageLog.error("Delivery attempt crashed", describeError(error));
      return "error";
    }
  }

  private async process(
    message: DeliveryMessage,
    receiveCount: number,
    log: Logger,
  ): Promise<DeliveryOutcome> {
    // Consistent read: the item was written moments ago.
    const request = await this.repository.findForDelivery(message.ownerId, message.requestId);
    if (request === undefined) {
      // Nothing ever deletes requests, so this is a bug or bad data, not a race.
      log.error("Request of the queue message does not exist");
      return "undeliverable";
    }

    // Idempotent consumer: a finished request is not sent again. This is what absorbs a
    // duplicate message (the queue deduplicates for only 5 minutes).
    if (isTerminal(request.status)) {
      log.info("Request is already finished, skipping", { status: request.status });
      return "alreadyDone";
    }

    // The Idempotency-Key is the request id: if we retry after a crash, the partner
    // recognises the request and does not process it twice.
    const payload = toPartnerPayload(request);
    const answer = await this.partner.send(payload);

    switch (answer.kind) {
      case "delivered":
        return this.onDelivered(message, payload, answer.statusCode, log);

      case "rejected":
        // No retry: asking again would get the same answer. Acknowledge the message.
        log.warn("Partner refused the request", { statusCode: answer.statusCode });
        return this.finish(message, "rejected", log);

      case "retryable":
        return this.onRetryable(message, receiveCount, answer.reason, log);
    }
  }

  private async onDelivered(
    message: DeliveryMessage,
    payload: PartnerPayload,
    partnerStatus: number,
    log: Logger,
  ): Promise<DeliveryOutcome> {
    // The audit copy comes first, then the status. If the S3 put throws (or the process
    // dies before the status update), the message is reported as failed and comes back. The
    // partner is called again with the same Idempotency-Key, so it handles the request once,
    // and the copy is written again under the same key. Writing the status first would
    // leave a "sent" request without its audit copy for good, because the retry would find
    // it finished and skip it.
    await this.audit.save(message.requestId, {
      sentAt: this.now().toISOString(),
      payload,
      partnerStatus,
    });
    return this.finish(message, "sent", log);
  }

  private async onRetryable(
    message: DeliveryMessage,
    receiveCount: number,
    reason: string,
    log: Logger,
  ): Promise<DeliveryOutcome> {
    const isLastAttempt = receiveCount >= this.maxReceiveCount;
    log.warn("Partner could not take the request", { reason, receiveCount, isLastAttempt });

    if (!isLastAttempt) return "retry";

    // The last attempt: once this message is reported as failed, SQS moves it to the DLQ.
    // Record that in the request and notify FIRST. The message is still reported as failed
    // afterwards (the outcome "failed" is not acknowledged), because that is what sends it
    // to the DLQ, where it is kept for inspection.
    return this.finish(message, "failed", log);
  }

  // Writes a terminal status and announces it. The outcome has the same name as the status.
  // A `false` from the repository means the request was no longer in a status that may lead
  // here, so somebody else finished it first (a duplicate run, for instance). Then there is
  // nothing left to do and nothing to announce: the run that won has done both.
  private async finish(
    message: DeliveryMessage,
    status: TerminalStatus,
    log: Logger,
  ): Promise<DeliveryOutcome> {
    const applied = await this.writeStatus(message, status);
    if (!applied) {
      log.info("Status was already changed by somebody else", { wantedStatus: status });
      return "alreadyDone";
    }

    // Best effort: the status is already saved, and a missing e-mail must not send a
    // delivered request through the retry loop.
    try {
      await this.notifier.publish({
        requestId: message.requestId,
        status,
        at: this.now().toISOString(),
      });
    } catch (error) {
      log.warn("Status notification failed", { status, ...describeError(error) });
    }
    return status;
  }

  private writeStatus(message: DeliveryMessage, status: TerminalStatus): Promise<boolean> {
    switch (status) {
      case "sent":
        return this.repository.markSent(message.ownerId, message.requestId);
      case "rejected":
        return this.repository.markRejected(message.ownerId, message.requestId);
      case "failed":
        return this.repository.markFailed(message.ownerId, message.requestId);
    }
  }
}
