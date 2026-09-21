import { z } from "zod";
import { isOwnerKey, ownerIdFromKey } from "./request-keys";

// The part of a stored request the enqueuer needs, read from the `NewImage` of a DynamoDB
// stream record after it was unmarshalled to a plain object: the ids, the partner and how many
// times the owner has sent the request again. Everything else in the image (subject, body, ...)
// is ignored on purpose: the enqueuer must never handle request text.
export const newRequestImageSchema = z
  .object({
    pk: z.string().refine(isOwnerKey, "must be a USER#<owner> key"),
    id: z.string().min(1),
    partner: z.string().min(1),
    // Only there once the request has been sent again (docs/api.md, "Storage"): a new request has none.
    retryCount: z.number().int().min(0).default(0),
  })
  .transform(({ pk, id, partner, retryCount }) => ({
    requestId: id,
    ownerId: ownerIdFromKey(pk),
    partner,
    retryCount,
  }));

export type EnqueueRequest = z.output<typeof newRequestImageSchema>;
