import type { RequestStatus } from "../domain/request";

/**
 * A request as the delivery pipeline needs it: the same identity and text the API returns, plus
 * `senderEmail` — the sender's e-mail captured once at creation (create-request), never
 * re-fetched on a delivery attempt. Not `PartnerRequest` (the API's own type): like
 * `traceparent`, `senderEmail` must never reach a client.
 */
export interface RequestForDelivery {
  id: string;
  subject: string;
  body: string;
  status: RequestStatus;
  createdAt: string;
  senderEmail: string;
}

// What the delivery side (enqueuer and delivery-worker) needs from storage. It is separate
// from RequestRepository on purpose: the API never changes a status, so its interface
// does not offer that, and the pipeline never lists or creates requests.
//
// The `mark...` methods change the status only if the request is in one of the statuses
// docs/api.md allows for that change (see src/domain/request-status.ts). They return:
//   true  - the status was changed by this call,
//   false - nothing changed, because the request is already somewhere else (usually
//           because a repeated or late message got there first). That is a normal
//           outcome, not an error; callers treat it as "already handled".
// Real failures (throttling, network, permissions) are thrown.
export interface DeliveryRepository {
  /** The request with a strongly consistent read, or `undefined` if there is none. */
  findForDelivery(ownerId: string, id: string): Promise<RequestForDelivery | undefined>;

  markQueued(ownerId: string, id: string): Promise<boolean>;
  markSent(ownerId: string, id: string): Promise<boolean>;
  markRejected(ownerId: string, id: string): Promise<boolean>;
  markFailed(ownerId: string, id: string): Promise<boolean>;
}
