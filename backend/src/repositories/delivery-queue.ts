// The outgoing side of the SQS FIFO queue (docs/api.md, "Queue").

export interface QueueMessage {
  /** Names the message inside one batch, so a failure can be traced back to its record. */
  id: string;
  body: string;
  /** FIFO ordering group. */
  groupId: string;
  /** FIFO deduplication: the same id inside the 5-minute window is delivered once. */
  deduplicationId: string;
  /**
   * The trace of the request in X-Ray's format (lib/tracing.ts, `toXRayTraceHeader`). It goes to
   * SQS as the system attribute AWSTraceHeader, and Lambda's tracing continues the trace in the
   * function that receives the message. Left out when there is no trace.
   */
  traceHeader?: string;
}

export interface DeliveryQueue {
  /**
   * Sends up to 10 messages in one call. SQS can accept some and refuse others, so it
   * returns the ids of the messages that were NOT accepted (empty when all were).
   * It throws when the whole call fails.
   */
  sendBatch(messages: QueueMessage[]): Promise<string[]>;
}
