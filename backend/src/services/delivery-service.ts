import type { PartnerClient } from "../clients/partner-client";
import type { XmlValidator } from "../clients/xml-validator";
import { decodeDeliveryMessage } from "../domain/delivery-message";
import type { DeliveryMessage } from "../domain/delivery-message";
import { describeProblem } from "../domain/exchange";
import type { Exchange } from "../domain/exchange";
import { readAnswer } from "../domain/reply-reader";
import { isTerminal } from "../domain/request-status";
import type { TerminalStatus } from "../domain/request-status";
import { buildSubmissionXml } from "../domain/submission-xml";
import { describeError } from "../lib/errors";
import type { Logger } from "../lib/logger";
import { logRequestEvent } from "../lib/request-events";
import { withSpan } from "../lib/tracing";
import type { ApiKeyProvider } from "../repositories/api-key-provider";
import type { DeliveryRepository } from "../repositories/delivery-repository";
import type { ExchangeStore } from "../repositories/exchange-store";
import type { StatusNotifier } from "../repositories/status-notifier";

/** One SQS message, as plain values (the handler maps the SQS record to this). */
export interface DeliveryJob {
  messageId: string;
  body: string;
  /** How many times SQS has handed this message out, this delivery included (starts at 1). */
  receiveCount: number;
}

// What happened to one message. The first four acknowledge the message (SQS deletes it);
// the others report it as failed, so SQS hands it out again or, in the end, moves it to the DLQ.
export type DeliveryOutcome =
  | "sent" // the partner accepted it; status "sent"
  | "rejected" // it will never be accepted (refused, invalid, or not writable as XML); status "rejected"
  | "failed" // last attempt: status "failed" written and announced; the owner can send it again
  | "alreadyDone" // it was finished before (or a parallel run finished it): nothing to do
  | "retry" // the partner could not take it now; SQS will hand it out again
  | "error" // something on our side broke (DynamoDB, S3, SSM, a bug); SQS will hand it out again
  | "undeliverable" // a malformed message or an unknown request; goes to the DLQ in the end
  | "notAttempted"; // an earlier message of the batch failed, so this one was not tried

// `failed` is acknowledged: the failure is handled (recorded, announced, and the owner sees it
// with a "Send again" button), the partner's group is not held back, and the DLQ stays for
// what could not be processed at all (docs/api.md, "delivery-worker", steps 7 and 10).
const ACKNOWLEDGED: readonly DeliveryOutcome[] = ["sent", "rejected", "failed", "alreadyDone"];

export type DeliveryCounts = Record<DeliveryOutcome, number>;

export interface DeliveryResult {
  /** The messages to report as failed: the first failure and every message after it. */
  failedMessageIds: string[];
  counts: DeliveryCounts;
}

export interface DeliverySettings {
  /** SENDER_NAME: the name in `Sender/Name` of every submission. */
  senderName: string;
  // The queue's maxReceiveCount: the receive after which SQS would give up on the message. It
  // is this function's LAST attempt: on it the worker writes "failed" and acknowledges the
  // message itself. Terraform passes the same number to the queue and to this function.
  maxReceiveCount: number;
}

// Step 2 of the pipeline (docs/api.md, "delivery-worker"): take a queued request, send it
// to the partner as XML, record the exchange.
//
// The queue may deliver the same message twice, and this code may die half-way. So every
// step is safe to repeat: a finished request is skipped, the partner deduplicates by the
// MessageId inside the document (which is the request id), the exchange record is
// overwritten and status changes are conditional.
//
// LOGGING: this class logs ids, outcomes, status codes, counts, problem counts and rule
// names, and nothing else. Never the XML, the subject, the text, the partner name, the
// description of a reply, or a message of the validator. All of those hold personal data.
export class DeliveryService {
  constructor(
    private readonly repository: DeliveryRepository,
    private readonly partner: PartnerClient,
    private readonly validator: XmlValidator,
    private readonly apiKeys: ApiKeyProvider,
    private readonly exchanges: ExchangeStore,
    private readonly notifier: StatusNotifier,
    private readonly settings: DeliverySettings,
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

    // Stop at the first message that goes back to the queue. The queue is FIFO: if message 2
    // is to be tried again, message 3 (which may belong to the same partner) must not be
    // delivered before it. So that message and everything after it go back, untouched.
    // A message whose last attempt ended as `failed` is acknowledged, so it does not stop the batch.
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
      // Anything unexpected: DynamoDB, S3 or SSM unavailable, missing permissions, a bug. The
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

    // One clock reading per attempt: the SentAt inside the XML and the `at` of the record agree.
    const at = this.now();

    // Step 2: build the XML. The text of the request is escaped there. Text that XML cannot
    // carry at all cannot be delivered by any number of retries, so it ends here, and
    // nobody is called.
    const submission = buildSubmissionXml({
      messageId: request.id,
      sentAt: at,
      senderName: this.settings.senderName,
      recipientName: request.partner,
      subject: request.subject,
      text: request.body,
    });
    if (!submission.ok) {
      log.warn("The request cannot be written as XML", { elements: submission.elements });
      logRequestEvent(log, {
        event: "delivery_attempted",
        role: "worker",
        requestId: message.requestId,
        attempt: receiveCount,
        outcome: "unrepresentable", // nobody was called: no `partnerMs`, no `httpStatus`
      });
      return this.recordAndFinish(
        message,
        {
          attempt: receiveCount,
          at: at.toISOString(),
          outcome: "unrepresentable",
          // There is no XML to show. The problems say where the bad character is, not what it is.
          request: {
            xml: "",
            valid: false,
            problems: submission.elements.map((element) => ({
              element,
              rule: "character not allowed in XML",
            })),
          },
          reply: null,
        },
        "rejected",
        request.createdAt,
        log,
      );
    }
    const xml = submission.xml;

    // Step 3: check our own XML against our copy of submission.xsd. The recipient would
    // refuse a document that fails it, and sending the same text again cannot change that.
    const checked = await this.validator.validateSubmission(xml);
    if (!checked.valid) {
      log.warn("The submission does not match the schema", {
        problemCount: checked.findings.length,
        problems: checked.findings.map(describeProblem),
      });
      logRequestEvent(log, {
        event: "delivery_attempted",
        role: "worker",
        requestId: message.requestId,
        attempt: receiveCount,
        outcome: "invalid_request", // nobody was called
      });
      return this.recordAndFinish(
        message,
        {
          attempt: receiveCount,
          at: at.toISOString(),
          outcome: "invalid_request",
          request: { xml, valid: false, problems: checked.findings },
          reply: null,
        },
        "rejected",
        request.createdAt,
        log,
      );
    }

    // Step 4: send it. Not being able to get the key is a problem of ours (SSM, a missing
    // permission): it throws, and the message comes back later ("error").
    const apiKey = await this.apiKeys.get();
    // The span `call recipient` is the part of the request's trace that the recipient is answerable
    // for (the trace itself is joined from the queue message by Lambda's tracing: nothing to do
    // here). Only ids and numbers go into it, like the log.
    const { answer, partnerMs } = await withSpan(
      "call recipient",
      { requestId: request.id, attempt: receiveCount },
      async (span) => {
        // How long the recipient took (the call only, not the key or the checks), for the request event.
        // A clock can step back, so the duration is never below 0.
        const calledAt = this.now().getTime();
        const reply = await this.partner.send({ xml, idempotencyKey: request.id, apiKey });
        const took = Math.max(0, this.now().getTime() - calledAt);
        // `undefined` (a timeout, a network error: no status) is left out by the guard.
        span.setAttributes({ httpStatus: reply.kind === "answer" ? reply.httpStatus : undefined, partnerMs: took });
        return { answer: reply, partnerMs: took };
      },
    );
    if (answer.kind === "answer" && (answer.httpStatus === 401 || answer.httpStatus === 403)) {
      // The recipient does not accept our key. It may have been rotated since we read it, so
      // forget it: the next attempt reads it from SSM again.
      this.apiKeys.invalidate();
    }

    // Step 5: the reply is untrusted input. Check its body, then let the reader decide.
    const replyCheck =
      answer.kind === "answer" && answer.body !== undefined
        ? await this.validator.validateReply(answer.body)
        : undefined;
    const reading = readAnswer(answer, replyCheck, request.id);

    log.info("The partner answered", {
      httpStatus: answer.kind === "answer" ? answer.httpStatus : undefined,
      noAnswer: answer.kind === "no-answer" ? answer.reason : undefined,
      decision: reading.decision,
      reason: reading.reason,
      replyValid: reading.reply?.valid,
      // Closed values only: a status and a code from the reply schema's enumerations, and
      // the recipient's own message id (a UUID). The description is free text: never logged.
      replyStatus: reading.facts?.status,
      replyCode: reading.facts?.code,
      replyMessageId: reading.facts?.messageId,
      replyProblems:
        replyCheck !== undefined && !replyCheck.valid ? replyCheck.findings.map(describeProblem) : undefined,
    });

    const exchange: Exchange = {
      attempt: receiveCount,
      at: at.toISOString(),
      outcome: reading.decision,
      request: { xml, valid: true, problems: [] },
      reply: reading.reply,
    };

    // The attempt is over: say how it ended, before the record and the status are written.
    logRequestEvent(log, {
      event: "delivery_attempted",
      role: "worker",
      requestId: message.requestId,
      attempt: receiveCount,
      outcome: reading.decision,
      httpStatus: answer.kind === "answer" ? answer.httpStatus : undefined, // none for a timeout
      partnerMs,
    });

    // Step 6: the record, then the status.
    switch (reading.decision) {
      case "delivered":
        return this.recordAndFinish(message, exchange, "sent", request.createdAt, log);

      case "refused":
        // No retry: asking again would get the same answer. Acknowledge the message.
        log.warn("Partner refused the request", { reason: reading.reason });
        return this.recordAndFinish(message, exchange, "rejected", request.createdAt, log);

      case "retry":
        return this.onRetry(message, receiveCount, exchange, reading.reason, request.createdAt, log);
    }
  }

  // A final outcome: the record comes FIRST, then the status. If the S3 put throws (or the
  // process dies before the status update), the message is reported as failed and comes
  // back. The partner deduplicates by the MessageId, so it handles the request once, and the
  // record is written again under the same key. Writing the status first would leave a "sent"
  // request without its record for good, because the retry would find it finished and skip it.
  private async recordAndFinish(
    message: DeliveryMessage,
    exchange: Exchange,
    status: TerminalStatus,
    createdAt: string,
    log: Logger,
  ): Promise<DeliveryOutcome> {
    await this.exchanges.save(message.requestId, exchange);
    return this.finish(message, status, exchange.attempt, createdAt, log);
  }

  private async onRetry(
    message: DeliveryMessage,
    receiveCount: number,
    exchange: Exchange,
    reason: string,
    createdAt: string,
    log: Logger,
  ): Promise<DeliveryOutcome> {
    const isLastAttempt = receiveCount >= this.settings.maxReceiveCount;
    log.warn("Partner could not take the request", { reason, receiveCount, isLastAttempt });

    // For a temporary failure the record is diagnostics only: the message is retried anyway.
    // So a failed write is logged and the retry goes on, instead of turning a partner
    // problem into an error of ours.
    try {
      await this.exchanges.save(message.requestId, exchange);
    } catch (error) {
      log.warn("The exchange record could not be written", describeError(error));
    }

    if (!isLastAttempt) return "retry";

    // The last attempt: write "failed" and announce it. The message is then acknowledged (the
    // outcome "failed" is in ACKNOWLEDGED), not left to move to the DLQ: the failure is handled
    // and the owner can send the request again. If writing "failed" throws, the outcome is
    // "error", the message goes back to the queue and ends in the DLQ, with the alarm.
    return this.finish(message, "failed", receiveCount, createdAt, log);
  }

  // Writes a terminal status and announces it. The outcome has the same name as the status.
  // A `false` from the repository means the request was no longer in a status that may lead
  // here, so somebody else finished it first (a duplicate run, for instance). Then there is
  // nothing left to do and nothing to announce: the run that won has done both.
  // `attempt` and `createdAt` (of the request) are only for the request event.
  private async finish(
    message: DeliveryMessage,
    status: TerminalStatus,
    attempt: number,
    createdAt: string,
    log: Logger,
  ): Promise<DeliveryOutcome> {
    const applied = await this.writeStatus(message, status);
    if (!applied) {
      log.info("Status was already changed by somebody else", { wantedStatus: status });
      return "alreadyDone";
    }

    // One clock reading: it is the time of the event and of the announcement.
    const finishedAt = this.now();

    // The request event, only now that the status change has really been applied.
    const closing = {
      role: "worker",
      requestId: message.requestId,
      attempt,
      // From the creation of the request to now, never below 0 (a clock can step back).
      sinceCreatedMs: Math.max(0, finishedAt.getTime() - Date.parse(createdAt)),
    } as const;
    switch (status) {
      case "sent":
        logRequestEvent(log, { event: "request_sent", toStatus: "sent", ...closing });
        break;
      case "rejected":
        logRequestEvent(log, { event: "request_rejected", toStatus: "rejected", ...closing });
        break;
      case "failed":
        logRequestEvent(log, { event: "request_failed", toStatus: "failed", ...closing });
        break;
    }

    // Best effort: the status is already saved, and a missing e-mail must not send a
    // delivered request through the retry loop.
    try {
      await this.notifier.publish({
        requestId: message.requestId,
        status,
        at: finishedAt.toISOString(),
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
