// The outgoing side of the SQS FIFO queue (docs/api.md, "Queue").

export interface QueueMessage {
  /** Names the message inside one batch, so a failure can be traced back to its record. */
  id: string;
  body: string;
  /** FIFO ordering group. */
  groupId: string;
  /** FIFO deduplication: the same id inside the 5-minute window is delivered once. */
  deduplicationId: string;
}

export interface DeliveryQueue {
  /**
   * Sends up to 10 messages in one call. SQS can accept some and refuse others, so it
   * returns the ids of the messages that were NOT accepted (empty when all were).
   * It throws when the whole call fails.
   */
  sendBatch(messages: QueueMessage[]): Promise<string[]>;
}
