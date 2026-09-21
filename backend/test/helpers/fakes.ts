import type { PartnerClient, PartnerSubmission } from "../../src/clients/partner-client";
import type { XmlValidator } from "../../src/clients/xml-validator";
import type { Exchange } from "../../src/domain/exchange";
import type { PartnerAnswer } from "../../src/domain/partner-answer";
import type { PartnerRequest, RequestStatus } from "../../src/domain/request";
import type { ValidationResult } from "../../src/domain/validation-result";
import type { ApiKeyProvider } from "../../src/repositories/api-key-provider";
import type { DeliveryQueue, QueueMessage } from "../../src/repositories/delivery-queue";
import type { DeliveryRepository } from "../../src/repositories/delivery-repository";
import type { ExchangeStore } from "../../src/repositories/exchange-store";
import type { StatusEvent, StatusNotifier } from "../../src/repositories/status-notifier";

// In-memory fakes for every port of the delivery services. They all write into one shared
// `journal`, so a test can check not only WHAT happened but also in which ORDER
// (for example "the status was written before the message was reported").

export type Journal = string[];

export const OWNER = "user-a";
export const NOW = new Date("2026-09-21T10:00:00.000Z");

/** A stored request with fake data. */
export function aRequest(overrides: Partial<PartnerRequest> = {}): PartnerRequest {
  return {
    id: "01J8Z3K5W0ABCDEFGHJKMNPQR1",
    partner: "Acme",
    subject: "Order 42",
    body: "Please ship.",
    status: "queued",
    createdAt: "2026-09-21T09:00:00.000Z",
    ...overrides,
  };
}

// The rules of docs/api.md, written out again here on purpose (not imported from src/):
// the fake is the reference the services are tested against.
const ALLOWED_FROM: Record<Exclude<RequestStatus, "created">, RequestStatus[]> = {
  queued: ["created"],
  sent: ["created", "queued"],
  rejected: ["created", "queued"],
  failed: ["created", "queued"],
};

export class FakeDeliveryRepository implements DeliveryRepository {
  private readonly items = new Map<string, PartnerRequest>();
  /** Operations (find, markQueued, markSent, ...) that should throw this error. */
  readonly failures = new Map<string, Error>();
  /** Runs right after a read: lets a test change the item as a parallel run would. */
  afterFind: (() => void) | undefined;

  constructor(private readonly journal: Journal) {}

  seed(request: PartnerRequest, ownerId = OWNER): void {
    this.items.set(`${ownerId}/${request.id}`, { ...request });
  }

  statusOf(id: string, ownerId = OWNER): RequestStatus | undefined {
    return this.items.get(`${ownerId}/${id}`)?.status;
  }

  setStatus(id: string, status: RequestStatus, ownerId = OWNER): void {
    const item = this.items.get(`${ownerId}/${id}`);
    if (item) item.status = status;
  }

  findForDelivery(ownerId: string, id: string): Promise<PartnerRequest | undefined> {
    this.journal.push("repo.find");
    const failure = this.failures.get("find");
    if (failure) return Promise.reject(failure);

    const item = this.items.get(`${ownerId}/${id}`);
    const copy = item === undefined ? undefined : { ...item };
    this.afterFind?.();
    return Promise.resolve(copy);
  }

  markQueued = (ownerId: string, id: string): Promise<boolean> => this.move("queued", ownerId, id);
  markSent = (ownerId: string, id: string): Promise<boolean> => this.move("sent", ownerId, id);
  markRejected = (ownerId: string, id: string): Promise<boolean> => this.move("rejected", ownerId, id);
  markFailed = (ownerId: string, id: string): Promise<boolean> => this.move("failed", ownerId, id);

  private move(to: Exclude<RequestStatus, "created">, ownerId: string, id: string): Promise<boolean> {
    const operation = `mark${to[0]?.toUpperCase()}${to.slice(1)}`;
    this.journal.push(`repo.${operation}`);
    const failure = this.failures.get(operation);
    if (failure) return Promise.reject(failure);

    const item = this.items.get(`${ownerId}/${id}`);
    if (item === undefined || !ALLOWED_FROM[to].includes(item.status)) return Promise.resolve(false);
    item.status = to;
    return Promise.resolve(true);
  }
}

export class FakePartnerClient implements PartnerClient {
  readonly sent: PartnerSubmission[] = [];
  /** What the partner answers. By default it accepts everything. */
  answer: (submission: PartnerSubmission) => PartnerAnswer = (submission) => acceptedAnswer(submission);

  constructor(private readonly journal: Journal) {}

  send(submission: PartnerSubmission): Promise<PartnerAnswer> {
    this.journal.push("partner.send");
    this.sent.push(submission);
    return Promise.resolve(this.answer(submission));
  }
}

/** A Reply document, written the way partner-sim writes it (fake ids). */
export function replyXml(options: { status?: "Accepted" | "Rejected"; relatesTo?: string; code?: string; description?: string } = {}): string {
  const status = options.status ?? "Accepted";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Reply xmlns="urn:aws-starter:reply:v1" version="1">',
    "  <MessageId>3f2b8c1e-5a4d-4e7b-9c1a-2d6e8f0a1b3c</MessageId>",
    options.relatesTo === undefined ? "" : `  <RelatesTo>${options.relatesTo}</RelatesTo>`,
    "  <ReceivedAt>2026-09-21T10:00:00.500Z</ReceivedAt>",
    "  <Result>",
    `    <Status>${status}</Status>`,
    options.code === undefined ? "" : `    <Code>${options.code}</Code>`,
    options.description === undefined ? "" : `    <Description>${options.description}</Description>`,
    "  </Result>",
    "</Reply>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The answer of a healthy recipient: 200 and a valid Accepted Reply about this submission. */
export const acceptedAnswer = (submission: PartnerSubmission): PartnerAnswer => ({
  kind: "answer",
  httpStatus: 200,
  body: replyXml({ relatesTo: submission.idempotencyKey }),
});

/** A 422 with a Rejected Reply. */
export const refusedAnswer = (submission: PartnerSubmission): PartnerAnswer => ({
  kind: "answer",
  httpStatus: 422,
  body: replyXml({
    status: "Rejected",
    relatesTo: submission.idempotencyKey,
    code: "RECIPIENT_REJECTED",
    description: "Refused by the rules of the recipient",
  }),
});

/** A 503 without a body, as the recipient answers when it is temporarily unavailable. */
export const unavailableAnswer: PartnerAnswer = { kind: "answer", httpStatus: 503, body: undefined };

export class FakeExchangeStore implements ExchangeStore {
  readonly saved: { requestId: string; exchange: Exchange }[] = [];
  private readonly records = new Map<string, Exchange>();
  failWith: Error | undefined;

  constructor(private readonly journal: Journal) {}

  save(requestId: string, exchange: Exchange): Promise<void> {
    this.journal.push("exchange.save");
    if (this.failWith) return Promise.reject(this.failWith);
    this.saved.push({ requestId, exchange });
    this.records.set(requestId, exchange);
    return Promise.resolve();
  }

  find(requestId: string): Promise<Exchange | undefined> {
    return Promise.resolve(this.records.get(requestId));
  }
}

export class FakeApiKeyProvider implements ApiKeyProvider {
  invalidations = 0;
  failWith: Error | undefined;

  constructor(
    private readonly journal: Journal,
    readonly key = "fake-api-key-for-tests",
  ) {}

  get(): Promise<string> {
    this.journal.push("apiKey.get");
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve(this.key);
  }

  invalidate(): void {
    this.journal.push("apiKey.invalidate");
    this.invalidations += 1;
  }
}

// A validator that says what the test tells it to. By default everything is valid. For the
// tests that need the real messages of libxml2 the real XsdXmlValidator is used instead.
export class FakeXmlValidator implements XmlValidator {
  readonly submissions: string[] = [];
  readonly replies: string[] = [];
  readonly events: string[] = [];
  submissionResult: ValidationResult = { valid: true };
  replyResult: ValidationResult = { valid: true };
  eventResult: ValidationResult = { valid: true };

  constructor(private readonly journal: Journal) {}

  validateSubmission(xml: string): Promise<ValidationResult> {
    this.journal.push("validator.submission");
    this.submissions.push(xml);
    return Promise.resolve(this.submissionResult);
  }

  validateReply(xml: string): Promise<ValidationResult> {
    this.journal.push("validator.reply");
    this.replies.push(xml);
    return Promise.resolve(this.replyResult);
  }

  validateEvent(xml: string): Promise<ValidationResult> {
    this.journal.push("validator.event");
    this.events.push(xml);
    return Promise.resolve(this.eventResult);
  }
}

export class FakeStatusNotifier implements StatusNotifier {
  readonly published: StatusEvent[] = [];
  failWith: Error | undefined;

  constructor(private readonly journal: Journal) {}

  publish(event: StatusEvent): Promise<void> {
    this.journal.push(`sns.publish:${event.status}`);
    if (this.failWith) return Promise.reject(this.failWith);
    this.published.push(event);
    return Promise.resolve();
  }
}

export class FakeDeliveryQueue implements DeliveryQueue {
  /** One entry per SendMessageBatch call. */
  readonly calls: QueueMessage[][] = [];
  /** Ids of messages the queue refuses (a partial failure of the batch). */
  readonly refuse = new Set<string>();
  /** Makes the whole call throw, for the call numbers given (0 = the first call). */
  readonly failCalls = new Map<number, Error>();

  constructor(private readonly journal: Journal) {}

  sendBatch(messages: QueueMessage[]): Promise<string[]> {
    this.journal.push("queue.send");
    const callNumber = this.calls.length;
    this.calls.push(messages);

    const failure = this.failCalls.get(callNumber);
    if (failure) return Promise.reject(failure);
    return Promise.resolve(messages.filter((m) => this.refuse.has(m.id)).map((m) => m.id));
  }
}
