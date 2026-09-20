import type { PartnerRequest } from "../domain/request";

// What the service needs from storage. The service depends on this interface, never on
// DynamoDB, so it can be tested with an in-memory fake and the storage can change without
// touching business rules.
//
// Every method takes the owner explicitly: there is no way to read or write a request
// without saying whose it is.
export interface RequestRepository {
  /** Stores a new request for `ownerId`. */
  create(ownerId: string, request: PartnerRequest): Promise<void>;

  /** The owner's requests, newest first, at most `limit` of them. */
  listByOwner(ownerId: string, limit: number): Promise<PartnerRequest[]>;

  /** One of the owner's requests, or `undefined` if there is none with that id. */
  findById(ownerId: string, id: string): Promise<PartnerRequest | undefined>;
}
