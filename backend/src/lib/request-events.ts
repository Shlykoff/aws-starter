import type { Decision } from "../domain/client-decision";
import type { ExchangeOutcome } from "../domain/exchange";
import type { Logger } from "./logger";

// The request events of docs/api.md ("Logs", "Request events"): one log line for each change in
// the life of a request. They are the audit trail (the table keeps only the current status), the
// source of the delivery metrics and the timeline of a request across all functions.
//
// One member of the union per row of the table in the docs, with exactly the fields of that
// row. So a call site cannot misspell an event or pass the field of another one: it does not
// compile. (The log guard, src/lib/log-fields.ts, checks the same names and shapes at run time.)
//
// A call is made only when the change has REALLY been applied (a conditional update that
// succeeded): never for a duplicate, an ignored event or a refused change. There is no user id and
// no text in an event: `role` says who acted.
export type RequestEvent =
  | { event: "request_created"; role: "user"; requestId: string; toStatus: "created" }
  | { event: "request_queued"; role: "enqueuer"; requestId: string; fromStatus: "created"; toStatus: "queued" }
  | {
      event: "delivery_attempted";
      role: "worker";
      requestId: string;
      attempt: number; // the receive count of the queue message
      outcome: ExchangeOutcome;
      // Only when the recipient was called (not for a request that could not be written as XML).
      partnerMs?: number;
      // Only when the recipient answered (not for a timeout or a network error).
      httpStatus?: number;
    }
  | {
      event: "request_sent";
      role: "worker";
      requestId: string;
      toStatus: "sent";
      attempt: number;
      sinceCreatedMs: number;
    }
  | {
      event: "request_rejected";
      role: "worker";
      requestId: string;
      toStatus: "rejected";
      attempt: number;
      sinceCreatedMs: number;
    }
  | {
      event: "request_failed";
      role: "worker";
      requestId: string;
      toStatus: "failed";
      attempt: number;
      sinceCreatedMs: number;
    }
  | {
      event: "retry_requested";
      role: "user";
      requestId: string;
      fromStatus: "failed";
      toStatus: "created";
      retryCount: number; // the new value
    }
  // The decision is the stored one: "Approved" or "Declined". Never its reason (text of the client).
  | { event: "decision_recorded"; role: "recipient"; requestId: string; decision: Decision };

/** Writes one request event: the message is always the same, the fields are those of the event. */
export function logRequestEvent(log: Logger, event: RequestEvent): void {
  log.info("Request event", { ...event });
}
