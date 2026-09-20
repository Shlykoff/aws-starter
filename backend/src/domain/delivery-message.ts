import { createHash } from "node:crypto";
import { z } from "zod";

// What travels on the SQS queue (docs/api.md, "Queue"). Ids only: the request text stays
// in DynamoDB, so it never sits in a queue or a dead-letter queue.
export const deliveryMessageSchema = z.object({
  requestId: z.string().min(1),
  ownerId: z.string().min(1),
});
export type DeliveryMessage = z.infer<typeof deliveryMessageSchema>;

export function encodeDeliveryMessage(message: DeliveryMessage): string {
  // The fields are named one by one, so nothing else can ever slip into the queue.
  return JSON.stringify({ requestId: message.requestId, ownerId: message.ownerId });
}

/** The message, or `undefined` when the body is not JSON or does not have the right fields. */
export function decodeDeliveryMessage(body: string): DeliveryMessage | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  const result = deliveryMessageSchema.safeParse(json);
  return result.success ? result.data : undefined;
}

/**
 * The FIFO `MessageGroupId`: one group per partner, so the messages of one partner are
 * delivered in order while different partners are handled independently.
 *
 * It is a hash because a group id may only contain letters, digits and some punctuation
 * (at most 128 characters), while the partner is free text. Trimming and lower-casing
 * make "Acme", "acme" and " ACME " the same partner.
 *
 * Trade-off: a message that keeps failing blocks the later messages of its own partner
 * until it lands in the dead-letter queue.
 */
export function messageGroupId(partner: string): string {
  return createHash("sha256").update(partner.trim().toLowerCase()).digest("hex");
}
