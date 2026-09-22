import { z } from "zod";

// Mirrors the "Request" model in docs/api.md. We call it PartnerRequest because the
// global DOM type `Request` (fetch) would clash with the name.

export const REQUEST_STATUSES = ["created", "queued", "sent", "failed", "rejected"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

// Server-side length limits (docs/api.md). The create form reuses them so the browser
// rejects the same input the API would; the API stays the authority.
export const REQUEST_LIMITS = { subject: 200, body: 5000 } as const;

// What the CLIENT did with the delivered message. It is independent of the delivery status:
// it arrives by webhook, minutes or months after `sent` (or even before), and never expires.
export const CLIENT_DECISIONS = ["Approved", "Declined"] as const;
export type ClientDecisionValue = (typeof CLIENT_DECISIONS)[number];

// What the screens show as the client's status: the decision, or "Waiting" while a delivered
// request has none. "Waiting" exists only here in the frontend, derived by `getClientStatus`
// (status.ts): the API never stores or sends it, so `ClientDecisionValue` stays what the API says.
export type ClientStatus = ClientDecisionValue | "Waiting";

// Strict on purpose, like the rest of the request: an unknown `decision` is an error, and so is
// `null` where the API omits the field. `reason` is text written by the recipient's side (third
// party): it is only ever shown as text, never as markup (see ClientDecisionCard).
export const clientDecisionSchema = z.object({
  decision: z.enum(CLIENT_DECISIONS),
  reason: z.string().optional(),
  // When the client acted (the event's own time), and when our system stored it. ISO 8601, UTC.
  at: z.string(),
  receivedAt: z.string(),
});
export type ClientDecision = z.infer<typeof clientDecisionSchema>;

// The type is derived from the schema, so the shape is described once and the API
// response is checked against it at runtime, not just trusted by the compiler.
export const partnerRequestSchema = z.object({
  id: z.string(),
  subject: z.string(),
  body: z.string(),
  status: z.enum(REQUEST_STATUSES),
  createdAt: z.string(),
  // Omitted (never null) until the client acts.
  clientDecision: clientDecisionSchema.optional(),
});
export type PartnerRequest = z.infer<typeof partnerRequestSchema>;

// What the user fills in; the server adds id, status and createdAt.
export type NewPartnerRequest = Pick<PartnerRequest, "subject" | "body">;
