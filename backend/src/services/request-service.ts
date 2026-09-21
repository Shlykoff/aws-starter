import { isValid as isUlid, ulid } from "ulid";
import type { CreateRequestInput } from "../domain/create-request";
import type { PartnerRequest } from "../domain/request";
import { NotFoundError, NotRetryableError } from "../lib/errors";
import type { Logger } from "../lib/logger";
import { logRequestEvent } from "../lib/request-events";
import { currentTraceparent, withSpan } from "../lib/tracing";
import type { RequestRepository } from "../repositories/request-repository";

// docs/api.md: GET /requests returns at most 50 items, newest first.
export const MAX_LIST_ITEMS = 50;

// The business rules of the request API (create, list, get, retry). No HTTP and no AWS types in here: the service gets plain
// values from the handler and the repository interface from the container.
export class RequestService {
  constructor(
    private readonly repository: RequestRepository,
    // The clock and the id generator are parameters only so that tests can control them.
    // Production code (the container) uses the defaults.
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = ulid,
  ) {}

  async create(ownerId: string, input: CreateRequestInput, log: Logger): Promise<PartnerRequest> {
    const request: PartnerRequest = {
      id: this.newId(),
      partner: input.partner,
      subject: input.subject,
      body: input.body,
      status: "created", // stage 1 never moves a request past "created"
      createdAt: this.now().toISOString(), // always UTC, e.g. 2026-09-20T12:00:00.000Z
    };
    // The span is the start of the request's trace: its traceparent is stored with the item, in
    // the same write, and the enqueuer and the webhook continue from it (lib/tracing.ts). The
    // event is logged inside it, so its line carries the trace id.
    await withSpan("create request", { requestId: request.id }, async () => {
      await this.repository.create(ownerId, request, currentTraceparent());
      logRequestEvent(log, { event: "request_created", role: "user", requestId: request.id, toStatus: "created" });
    });
    return request;
  }

  /** The owner's requests, newest first (the repository sorts). */
  async list(ownerId: string): Promise<PartnerRequest[]> {
    return this.repository.listByOwner(ownerId, MAX_LIST_ITEMS);
  }

  /** One request of this owner. A request of somebody else is "not found", not "forbidden". */
  async get(ownerId: string, id: string): Promise<PartnerRequest> {
    // A malformed id cannot exist, so answer 404 without a database read. It also keeps
    // absurdly long ids away from DynamoDB, which would reject them as a 500.
    if (!isUlid(id)) throw new NotFoundError();

    const request = await this.repository.findById(ownerId, id);
    if (request === undefined) throw new NotFoundError();
    return request;
  }

  /**
   * Sends a failed request again (docs/api.md, "Sending a failed request again"). The request
   * goes back to "created"; the enqueuer sees that in the table's stream and queues it.
   */
  async retry(ownerId: string, id: string, log: Logger): Promise<PartnerRequest> {
    // A malformed id cannot exist: 404 without touching the database (see `get`).
    if (!isUlid(id)) throw new NotFoundError();

    // A retry starts a NEW trace: its traceparent replaces the stored one, in the same update.
    // The span ends before the errors below are thrown: "not found" and "not failed" are answers
    // of the API, not failures of this span.
    const outcome = await withSpan("retry request", { requestId: id }, async () => {
      const result = await this.repository.retry(ownerId, id, currentTraceparent());
      if (result.kind === "restarted") {
        logRequestEvent(log, {
          event: "retry_requested",
          role: "user",
          requestId: id,
          fromStatus: "failed",
          toStatus: "created",
          retryCount: result.retryCount,
        });
      }
      return result;
    });
    switch (outcome.kind) {
      case "restarted":
        return outcome.request;
      case "not_found":
        throw new NotFoundError();
      case "not_failed":
        throw new NotRetryableError(outcome.status);
    }
  }
}
