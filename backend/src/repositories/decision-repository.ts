import type { StoredClientDecision } from "../domain/client-decision";

/** What happened to one event (`unknown_request` = no request has that id). */
export type RecordOutcome = "applied" | "duplicate" | "ignored" | "unknown_request";

// What the webhook service needs from storage. It is separate from the other repositories on
// purpose: the webhook is the one caller that has no owner (`sub`) and finds the request by
// its id alone, and the only thing it may change is the client's decision.
export interface DecisionRepository {
  /**
   * Stores the decision on the request `requestId`, whatever its delivery status is, if the
   * request has no decision yet or the event is later than the stored one. Otherwise nothing
   * changes and the outcome says why: `duplicate` (the same event again) or `ignored` (an
   * older or equally old one). The latest `OccurredAt` wins, not the last one received.
   *
   * `occurredAtMs` is `OccurredAt` as epoch milliseconds: the number that puts events in order.
   * Real failures (throttling, network, permissions) are thrown.
   */
  recordDecision(
    requestId: string,
    decision: StoredClientDecision,
    occurredAtMs: number,
  ): Promise<RecordOutcome>;
}
