import type { SendMessageBatchResultEntry } from "@aws-sdk/client-sqs";

// A "successfully sent" result entry for the message with this batch id. The SDK types want
// a MessageId and a checksum; the code under test only reads `Id`, so these are fake.
export const sent = (id: string | undefined): SendMessageBatchResultEntry => ({
  Id: id,
  MessageId: `sqs-message-of-${id ?? "unknown"}`,
  MD5OfMessageBody: "not-checked",
});
