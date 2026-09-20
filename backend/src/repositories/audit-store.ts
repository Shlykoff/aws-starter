import type { PartnerPayload } from "../domain/partner-payload";

// The copy of a delivered request that is kept in S3 (docs/api.md, "S3 audit copy").
export interface AuditCopy {
  /** ISO 8601, UTC. */
  sentAt: string;
  /** Exactly what was sent to the partner. */
  payload: PartnerPayload;
  /** The HTTP status the partner answered with. */
  partnerStatus: number;
}

export interface AuditStore {
  /** Stores the copy under a key derived from the request id. Storing it twice overwrites. */
  save(requestId: string, copy: AuditCopy): Promise<void>;
}
