import { SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { DeliveryQueue, QueueMessage } from "./delivery-queue";

export class SqsDeliveryQueue implements DeliveryQueue {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async sendBatch(messages: QueueMessage[]): Promise<string[]> {
    const result = await this.client.send(
      new SendMessageBatchCommand({
        QueueUrl: this.queueUrl,
        Entries: messages.map((message) => ({
          Id: message.id,
          MessageBody: message.body,
          MessageGroupId: message.groupId,
          MessageDeduplicationId: message.deduplicationId,
        })),
      }),
    );

    // A batch call can succeed as a whole while single entries are refused: those are
    // listed in `Failed`. Ignoring that list would silently lose messages.
    return (result.Failed ?? []).map((entry) => entry.Id ?? "");
  }
}
