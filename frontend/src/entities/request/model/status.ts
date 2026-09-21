import type { ClientStatus, PartnerRequest, RequestStatus } from "./types";

// `sent`, `rejected` and `failed` never change again (docs/api.md, "Statuses"). Only
// `created` and `queued` can still move, so only those are worth refreshing.
const TERMINAL_STATUSES: readonly RequestStatus[] = ["sent", "rejected", "failed"];

export function isTerminalStatus(status: RequestStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// How often the pages ask the API for news while a request is not terminal yet. The
// contract says "every few seconds"; a longer pause would feel stuck, a shorter one only
// spends the small read capacity of the table (docs/api.md, "Storage").
export const STATUS_POLL_INTERVAL_MS = 5_000;

// How often the details page asks for news while a delivered request has no decision yet.
// Much slower than the status poll: the client may take minutes or months, so there is
// nothing to gain from asking every few seconds, and a decision is seen within half a
// minute of arriving. A person leaving the tab open costs two reads a minute. There is no
// deadline: the polling stops when a decision shows up or the page is left, never by time.
export const DECISION_POLL_INTERVAL_MS = 30_000;

// True for a delivered request whose client has not decided yet: the one case where a
// decision is still expected. `created` and `queued` are not delivered (the fast status
// poll covers them), and `failed` and `rejected` never were, so nothing is awaited there.
export function isAwaitingDecision(request: Pick<PartnerRequest, "status" | "clientDecision">): boolean {
  return request.status === "sent" && request.clientDecision === undefined;
}

// What to show as the client's status, or undefined when nothing is to be shown. A decision is
// shown whenever there is one, whatever the delivery status is (the webhook accepts it for any
// request). Without one, only a delivered request is "Waiting": for the others (created, queued,
// rejected, failed) nothing is expected from the client, so no client status is shown. Derived
// here on every render, never stored: when the decision arrives, the result changes by itself.
export function getClientStatus(request: Pick<PartnerRequest, "status" | "clientDecision">): ClientStatus | undefined {
  if (request.clientDecision !== undefined) return request.clientDecision.decision;
  return isAwaitingDecision(request) ? "Waiting" : undefined;
}
