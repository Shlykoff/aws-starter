import type { RequestStatus } from "./types";

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
