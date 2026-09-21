// The client's decision on a delivered request (docs/api.md, "Model" and "Client decision
// (webhook)"): approved (for example paid) or declined (for example out of stock). It arrives
// by webhook, minutes or months after delivery, and is independent of the delivery status.

export const DECISIONS = ["Approved", "Declined"] as const;
export type Decision = (typeof DECISIONS)[number];

export function isDecision(value: string | null | undefined): value is Decision {
  return DECISIONS.some((known) => known === value);
}

/** What the API returns as `clientDecision`. */
export interface ClientDecision {
  decision: Decision;
  /** Text from the recipient's side (1-500 characters). Clients must show it as text only. */
  reason?: string;
  /** ISO 8601, UTC: when the client acted (`OccurredAt` of the event). */
  at: string;
  /** ISO 8601, UTC: when we stored it. */
  receivedAt: string;
}

/**
 * What is stored in the item under `clientDecision`: the API's fields plus the id of the event.
 * The id is how a repeated delivery of the same event is recognised. It is never returned.
 */
export interface StoredClientDecision extends ClientDecision {
  eventId: string;
}

/**
 * The API's view of a stored decision. The fields are copied one by one, so `eventId` (and
 * anything that may be added to the stored map later) can never end up in a response.
 */
export function toClientDecision(stored: StoredClientDecision): ClientDecision {
  return {
    decision: stored.decision,
    // `reason` is left out, not set to undefined, when there is none.
    ...(stored.reason !== undefined && { reason: stored.reason }),
    at: stored.at,
    receivedAt: stored.receivedAt,
  };
}
