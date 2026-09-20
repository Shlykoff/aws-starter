import { z } from "zod";
import { isOwnerKey, ownerIdFromKey } from "./request-keys";

// The part of a stored request the enqueuer needs, read from the `NewImage` of a DynamoDB
// stream record after it was unmarshalled to a plain object. Everything else in the image
// (subject, body, ...) is ignored on purpose: the enqueuer must never handle request text.
export const newRequestImageSchema = z
  .object({
    pk: z.string().refine(isOwnerKey, "must be a USER#<owner> key"),
    id: z.string().min(1),
    partner: z.string().min(1),
  })
  .transform(({ pk, id, partner }) => ({ requestId: id, ownerId: ownerIdFromKey(pk), partner }));

export type EnqueueRequest = z.output<typeof newRequestImageSchema>;
