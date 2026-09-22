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
 * The FIFO `MessageGroupId`: this project has exactly one requester-to-recipient path, so
 * every message shares one fixed group (order within it is still FIFO). It used to be a hash
 * of the free-text partner name, one group per partner; now there is only one recipient, so a
 * literal replaces it. Any value that fits SQS FIFO's allowed characters (letters, digits and
 * `!"#$%&'()*+,-./:;=?@_` up to 128 characters) would do.
 *
 * Trade-off: a message that keeps failing blocks every later message until it is acknowledged
 * (its last attempt) or lands in the dead-letter queue — there is only one group to block.
 */
export const MESSAGE_GROUP_ID = "requests";

/**
 * The FIFO `MessageDeduplicationId`: the request id for the first send. A FIFO queue drops a
 * message whose deduplication id it has seen in the last 5 minutes, so a request sent again
 * gets `<requestId>-r<retryCount>`: never the same as the first send or an earlier retry, and
 * the same when the enqueuer repeats one send (a retried stream record), which is what the
 * queue must drop.
 */
export function deduplicationId(requestId: string, retryCount: number): string {
  return retryCount === 0 ? requestId : `${requestId}-r${retryCount}`;
}
