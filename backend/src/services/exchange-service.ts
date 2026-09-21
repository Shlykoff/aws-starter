import { isValid as isUlid } from "ulid";
import type { Exchange } from "../domain/exchange";
import { NotFoundError } from "../lib/errors";
import type { ExchangeStore } from "../repositories/exchange-store";
import type { RequestRepository } from "../repositories/request-repository";

// GET /requests/{id}/exchange (docs/api.md): the XML we sent and the XML that came back.
// `undefined` means "the request is yours, but no delivery attempt is recorded yet": a normal
// state, so it is a value, not an error (the handler answers 204). A 404 is only for a request
// that does not exist for the caller.
// The record holds the text of the request, so the owner is checked FIRST, in the table, and
// only then does S3 get touched. The S3 key contains the request id and nothing about the
// owner: without this check anybody who guessed an id could read the record.
export class ExchangeService {
  constructor(
    private readonly requests: RequestRepository,
    private readonly exchanges: ExchangeStore,
  ) {}

  async get(ownerId: string, id: string): Promise<Exchange | undefined> {
    // The same rules as RequestService.get: a malformed id cannot exist, and a request of
    // somebody else is "not found", not "forbidden", so existence is not leaked.
    if (!isUlid(id)) throw new NotFoundError();
    const request = await this.requests.findById(ownerId, id);
    if (request === undefined) throw new NotFoundError();

    // The request is the caller's own, so saying that nothing was recorded yet leaks nothing.
    return this.exchanges.find(request.id);
  }
}
