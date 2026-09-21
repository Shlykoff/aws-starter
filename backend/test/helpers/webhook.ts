import { createHmac } from "node:crypto";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

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

interface WebhookEventOptions {
  /** The bytes of the body. `undefined` = the event has no body at all. */
  body?: Buffer | string | undefined;
  token?: string;
  timestamp?: string | null; // null: the header is not sent
  /** Replaces the computed signature header. `null`: the header is not sent. */
  signature?: string | null;
  contentType?: string | null; // null: the header is not sent
  isBase64Encoded?: boolean;
  /** Extra headers, written as they are (the tests use them to check case-insensitivity). */
  headers?: Record<string, string>;
}

/** A signed POST /webhooks/partner, as API Gateway's HTTP API (payload 2.0) delivers it. */
export function webhookEvent(options: WebhookEventOptions = {}): APIGatewayProxyEventV2 {
  const bytes = options.body === undefined ? Buffer.alloc(0) : Buffer.from(options.body);
  const timestamp = options.timestamp === undefined ? String(NOW_SECONDS) : options.timestamp;
  const signature =
    options.signature === undefined
      ? sign(options.token ?? WEBHOOK_TOKEN, timestamp ?? "", bytes)
      : options.signature;
  const contentType = options.contentType === undefined ? "application/xml" : options.contentType;

  const headers: Record<string, string> = { ...options.headers };
  if (timestamp !== null) headers["x-webhook-timestamp"] = timestamp;
  if (signature !== null) headers["x-webhook-signature"] = signature;
  if (contentType !== null) headers["content-type"] = contentType;

  return {
    version: "2.0",
    routeKey: "POST /webhooks/partner",
    rawPath: "/webhooks/partner",
    rawQueryString: "",
    headers,
    requestContext: {
      accountId: "test-account",
      apiId: "test-api",
      domainName: "api.example.test",
      domainPrefix: "api",
      http: { method: "POST", path: "/webhooks/partner", protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "vitest" },
      requestId: "test-gateway-request-id",
      routeKey: "POST /webhooks/partner",
      stage: "$default",
      time: "21/Sep/2026:10:15:40 +0000",
      timeEpoch: NOW_SECONDS * 1000,
    },
    ...(options.body === undefined
      ? {}
      : { body: options.isBase64Encoded ? bytes.toString("base64") : bytes.toString("utf8") }),
    isBase64Encoded: options.isBase64Encoded ?? false,
  };
}
