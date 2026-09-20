import { z } from "zod";

// Mirrors the "Request" model in docs/api.md. We call it PartnerRequest because the
// global DOM type `Request` (fetch) would clash with the name.

export const REQUEST_STATUSES = ["created", "queued", "sent", "failed", "rejected"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

// Server-side length limits (docs/api.md). The create form reuses them so the browser
// rejects the same input the API would; the API stays the authority.
export const REQUEST_LIMITS = { partner: 100, subject: 200, body: 5000 } as const;

// The type is derived from the schema, so the shape is described once and the API
// response is checked against it at runtime, not just trusted by the compiler.
export const partnerRequestSchema = z.object({
  id: z.string(),
  partner: z.string(),
  subject: z.string(),
  body: z.string(),
  status: z.enum(REQUEST_STATUSES),
  createdAt: z.string(),
});
export type PartnerRequest = z.infer<typeof partnerRequestSchema>;

// What the user fills in; the server adds id, status and createdAt.
export type NewPartnerRequest = Pick<PartnerRequest, "partner" | "subject" | "body">;
