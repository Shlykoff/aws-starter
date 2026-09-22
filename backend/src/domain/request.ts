import type { ClientDecision } from "./client-decision";

// The request model from docs/api.md ("Request"). It is called `PartnerRequest` here so it
// does not shadow the global `Request` type of the fetch API.

// The full lifecycle from docs/api.md. Stage 1 only ever sets "created"; the other values
// are written by the delivery pipeline of stage 2.
export const REQUEST_STATUSES = ["created", "queued", "sent", "failed", "rejected"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

// This is exactly what the API returns. The owner is deliberately not a field: it lives
// only in the DynamoDB partition key, so it cannot leak into a response by accident.
export interface PartnerRequest {
  id: string; // ULID, time-sortable
  subject: string;
  body: string;
  status: RequestStatus;
  createdAt: string; // ISO 8601, UTC
  // What the client did with the delivered message. Absent until the webhook stores it (a
  // new request never has one); independent of `status`.
  clientDecision?: ClientDecision;
}
