import type { PartnerClient, PartnerResult } from "../../src/clients/partner-client";
import type { PartnerPayload } from "../../src/domain/partner-payload";
import type { PartnerRequest, RequestStatus } from "../../src/domain/request";
import type { AuditCopy, AuditStore } from "../../src/repositories/audit-store";
import type { DeliveryQueue, QueueMessage } from "../../src/repositories/delivery-queue";
import type { DeliveryRepository } from "../../src/repositories/delivery-repository";
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
  readonly sent: PartnerPayload[] = [];
  /** What the partner answers. By default it accepts everything. */
  answer: (payload: PartnerPayload) => PartnerResult = () => ({ kind: "delivered", statusCode: 200 });

  constructor(private readonly journal: Journal) {}

  send(payload: PartnerPayload): Promise<PartnerResult> {
    this.journal.push("partner.send");
    this.sent.push(payload);
    return Promise.resolve(this.answer(payload));
  }
}

export class FakeAuditStore implements AuditStore {
  readonly saved: { requestId: string; copy: AuditCopy }[] = [];
  failWith: Error | undefined;

  constructor(private readonly journal: Journal) {}

  save(requestId: string, copy: AuditCopy): Promise<void> {
    this.journal.push("audit.save");
    if (this.failWith) return Promise.reject(this.failWith);
    this.saved.push({ requestId, copy });
    return Promise.resolve();
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
