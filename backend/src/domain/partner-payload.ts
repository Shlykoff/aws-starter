import type { PartnerRequest } from "./request";

// The body sent to the partner (docs/api.md, "Partner webhook"): the request without its
// status, which is our own bookkeeping. The same object is stored as the S3 audit copy.
export type PartnerPayload = Omit<PartnerRequest, "status">;

export function toPartnerPayload(request: PartnerRequest): PartnerPayload {
  // Field by field, so a field added to the stored item later is not sent to the partner
  // by accident.
  return {
    id: request.id,
    partner: request.partner,
    subject: request.subject,
    body: request.body,
    createdAt: request.createdAt,
  };
}
