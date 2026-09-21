import { createHmac } from "node:crypto";
import type { ApiEvent, ApiResult } from "../../src/lib/http";
import { CORS_HEADERS, restEvent } from "./events";

// Builders for the events of the webhook: a DecisionEvent document and the API Gateway
// event that carries it, signed the way contracts/webhook-api.md says. All values are fake.

export const WEBHOOK_TOKEN = "test-webhook-token-not-a-secret";
export const REQUEST_ID = "01M30JDSMHY8CRX59V35WV731S";
export const EVENT_ID = "3f0c6b1e-5a4d-4e7b-9c1a-2d6e8f0a1b3c";
/** Our clock in the handler tests: 2026-09-21T10:15:40Z, 8 seconds after the signature vector. */
export const NOW_SECONDS = 1_789_985_740;

/** The signature header of the contract: v1= and the HMAC-SHA256 of "<timestamp>.<body>". */
export function sign(token: string, timestamp: string, body: Buffer | string): string {
  const mac = createHmac("sha256", Buffer.from(token, "utf8")).update(timestamp).update(".").update(body);
  return `v1=${mac.digest("hex")}`;
}

/** A DecisionEvent written like the fixtures. `reason: null` leaves the element out. */
export function eventXml(
  fields: {
    eventId?: string;
    occurredAt?: string;
    relatesTo?: string;
    decision?: string;
    reason?: string | null;
  } = {},
): string {
  const reason = fields.reason === undefined || fields.reason === null ? "" : `\n  <Reason>${fields.reason}</Reason>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<DecisionEvent xmlns="urn:aws-starter:event:v1" version="1">
  <EventId>${fields.eventId ?? EVENT_ID}</EventId>
  <OccurredAt>${fields.occurredAt ?? "2026-09-21T10:15:32Z"}</OccurredAt>
  <RelatesTo>${fields.relatesTo ?? REQUEST_ID}</RelatesTo>
  <Decision>${fields.decision ?? "Approved"}</Decision>${reason}
</DecisionEvent>
`;
}

/**
 * What the webhook answers with a status: no body, and the CORS header that every response of
 * the API carries (src/lib/http.ts).
 */
export const answer = (statusCode: number): ApiResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: "",
});

interface WebhookEventOptions {
  /** The bytes of the body. `undefined` = the event has no body at all. */
  body?: Buffer | string | undefined;
  token?: string;
  timestamp?: string | null; // null: the header is not sent
  /** Replaces the computed signature header. `null`: the header is not sent. */
  signature?: string | null;
  contentType?: string | null; // null: the header is not sent
  isBase64Encoded?: boolean;
  /**
   * Extra headers, written as they are (the tests use them to check case-insensitivity).
   * `null`: the event has no headers at all (`headers: null`), the signature ones included.
   */
  headers?: Record<string, string> | null;
}

/** The same event with one header set. Any case of the name replaces the one that was there. */
export function withHeader(event: ApiEvent, name: string, value: string): ApiEvent {
  const kept = Object.entries(event.headers ?? {}).filter(([key]) => key.toLowerCase() !== name.toLowerCase());
  return { ...event, headers: { ...Object.fromEntries(kept), [name]: value } };
}

/**
 * A signed POST /webhooks/partner, as a REST API delivers it. The header names are written the
 * way a sender usually writes them (Title-Case); a REST API passes them on with that case.
 */
export function webhookEvent(options: WebhookEventOptions = {}): ApiEvent {
  const bytes = options.body === undefined ? Buffer.alloc(0) : Buffer.from(options.body);
  const timestamp = options.timestamp === undefined ? String(NOW_SECONDS) : options.timestamp;
  const signature =
    options.signature === undefined
      ? sign(options.token ?? WEBHOOK_TOKEN, timestamp ?? "", bytes)
      : options.signature;
  const contentType = options.contentType === undefined ? "application/xml" : options.contentType;

  const headers: Record<string, string> = { ...options.headers };
  if (timestamp !== null) headers["X-Webhook-Timestamp"] = timestamp;
  if (signature !== null) headers["X-Webhook-Signature"] = signature;
  if (contentType !== null) headers["Content-Type"] = contentType;

  return restEvent({
    httpMethod: "POST",
    resource: "/webhooks/partner",
    headers: options.headers === null ? null : headers,
    body:
      options.body === undefined
        ? null
        : options.isBase64Encoded
          ? bytes.toString("base64")
          : bytes.toString("utf8"),
    isBase64Encoded: options.isBase64Encoded,
    requestTimeEpoch: NOW_SECONDS * 1000,
  });
}
