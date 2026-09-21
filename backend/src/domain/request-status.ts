import type { RequestStatus } from "./request";

// The status rules of docs/api.md ("Statuses"), in one place. The DynamoDB repository turns
// them into ConditionExpressions and the delivery service uses `isTerminal`, so the rules
// are written down once and cannot drift apart.
//
//   created --> queued --> sent | rejected | failed
//      `-------------------^  (the worker may see a request before the enqueuer wrote "queued")
//   failed --> created         (the owner sends a failed request again: POST /requests/{id}/retry)

/**
 * Final states for the delivery worker: it never touches a request in one of them. `sent` and
 * `rejected` never change again; only the owner can move a `failed` request, back to `created`.
 */
export const TERMINAL_STATUSES = ["sent", "rejected", "failed"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** States in which a request still has to be delivered. The rest of the statuses are terminal. */
export const DELIVERABLE_STATUSES = ["created", "queued"] as const;

export function isTerminal(status: RequestStatus): status is TerminalStatus {
  return TERMINAL_STATUSES.some((terminal) => terminal === status);
}

// For each target status: the statuses a request may be in right before the change.
const PREVIOUS_STATUSES: Record<RequestStatus, readonly RequestStatus[]> = {
  created: ["failed"], // the start of a new request, or the owner sending a failed one again
  queued: ["created"], // only from created, so a late "queued" never overwrites a result
  sent: DELIVERABLE_STATUSES,
  rejected: DELIVERABLE_STATUSES,
  failed: DELIVERABLE_STATUSES,
};

/** The statuses from which a request may move to `target` (empty: it can never be moved there). */
export function allowedPreviousStatuses(target: RequestStatus): readonly RequestStatus[] {
  return PREVIOUS_STATUSES[target];
}
