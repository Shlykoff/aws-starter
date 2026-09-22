import { z } from "zod";
import { isOwnerKey, ownerIdFromKey } from "./request-keys";

// The part of a stored request the enqueuer needs, read from the `NewImage` of a DynamoDB
// stream record after it was unmarshalled to a plain object: the ids, how many times the owner
// has sent the request again and the trace it belongs to. Everything else in the image (subject,
// body, senderEmail, ...) is ignored on purpose: the enqueuer must never handle request text or
// the sender's identity.
export const newRequestImageSchema = z
  .object({
    pk: z.string().refine(isOwnerKey, "must be a USER#<owner> key"),
    id: z.string().min(1),
    // Only there once the request has been sent again (docs/api.md, "Storage"): a new request has none.
    retryCount: z.number().int().min(0).default(0),
    // The W3C traceparent of the request's trace (lib/tracing.ts), if it was created with tracing on.
    // Only a string is read here; whether it is a valid traceparent is decided where it is used
    // (`contextFromTraceparent`, which ignores a bad one). A malformed value must never make the
    // record unreadable: a request must be delivered whatever its trace looks like. So anything
    // that is not a string of a sane length is dropped, not reported.
    traceparent: z.string().max(128).optional().catch(undefined),
  })
  .transform(({ pk, id, retryCount, traceparent }) => ({
    requestId: id,
    ownerId: ownerIdFromKey(pk),
    retryCount,
    ...(traceparent !== undefined && { traceparent }),
  }));

export type EnqueueRequest = z.output<typeof newRequestImageSchema>;
