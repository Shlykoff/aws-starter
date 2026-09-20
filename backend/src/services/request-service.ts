import { isValid as isUlid, ulid } from "ulid";
import type { CreateRequestInput } from "../domain/create-request";
import type { PartnerRequest } from "../domain/request";
import { NotFoundError } from "../lib/errors";
import type { RequestRepository } from "../repositories/request-repository";

// docs/api.md: GET /requests returns at most 50 items, newest first.
export const MAX_LIST_ITEMS = 50;

// The business rules of stage 1. No HTTP and no AWS types in here: the service gets plain
// values from the handler and the repository interface from the container.
export class RequestService {
  constructor(
    private readonly repository: RequestRepository,
    // The clock and the id generator are parameters only so that tests can control them.
    // Production code (the container) uses the defaults.
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = ulid,
  ) {}

  async create(ownerId: string, input: CreateRequestInput): Promise<PartnerRequest> {
    const request: PartnerRequest = {
      id: this.newId(),
      partner: input.partner,
      subject: input.subject,
      body: input.body,
      status: "created", // stage 1 never moves a request past "created"
      createdAt: this.now().toISOString(), // always UTC, e.g. 2026-09-20T12:00:00.000Z
    };
    await this.repository.create(ownerId, request);
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
}
