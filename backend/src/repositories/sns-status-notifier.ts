import { PublishCommand } from "@aws-sdk/client-sns";
import type { SNSClient } from "@aws-sdk/client-sns";
import type { StatusEvent, StatusNotifier } from "./status-notifier";

export class SnsStatusNotifier implements StatusNotifier {
  constructor(
    private readonly client: SNSClient,
    private readonly topicArn: string,
  ) {}

  async publish(event: StatusEvent): Promise<void> {
    await this.client.send(
      new PublishCommand({
        TopicArn: this.topicArn,
        Message: JSON.stringify({ requestId: event.requestId, status: event.status, at: event.at }),
        // The subscription's filter policy looks at this attribute, not at the message
        // body, so e-mails can be limited to "failed" and "rejected".
        MessageAttributes: { status: { DataType: "String", StringValue: event.status } },
      }),
    );
  }
}
