import type { PartnerPayload } from "../domain/partner-payload";

// What the delivery service knows about the partner: send a request, get one of three
// answers. Classification (what counts as "try again later") is decided by the client, so
// the service never looks at HTTP status codes.
export type PartnerResult =
  /** 2xx: the partner accepted the request. */
  | { kind: "delivered"; statusCode: number }
  /** A 4xx that will not get better by retrying: the partner refused the request for good. */
  | { kind: "rejected"; statusCode: number }
  /** Might work later: timeout, network error, 408, 429 or 5xx. `reason` is for the logs. */
  | { kind: "retryable"; reason: string; statusCode?: number };

export interface PartnerClient {
  /**
   * Sends the request to the partner. The `Idempotency-Key` is `payload.id`, so the same
   * request sent twice is one request for the partner. It never throws because of the
   * partner's answer; it throws only for problems on our side (for example no credentials).
   */
  send(payload: PartnerPayload): Promise<PartnerResult>;
}
