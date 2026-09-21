import type { PartnerRequest, RequestStatus } from "../domain/request";

// What `retry` found.
export type RetryOutcome =
  // it was failed and is `created` again; `retryCount` is the new number of sends (for the log,
  // never for the API: the request itself does not carry it)
  | { kind: "restarted"; request: PartnerRequest; retryCount: number }
  | { kind: "not_found" } // no such request for this owner
  | { kind: "not_failed"; status: RequestStatus }; // it exists, but has this other status

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

  /**
   * Sends a request again: one conditional update that moves it from `failed` back to
   * `created` and counts the send. It answers "not found" and "not failed" as values, not as
   * errors: they are answers for the caller, not failures of the storage.
   */
  retry(ownerId: string, id: string): Promise<RetryOutcome>;
}
