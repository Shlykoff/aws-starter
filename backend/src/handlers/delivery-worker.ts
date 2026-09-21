import type { Context, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { container } from "../container-worker";
import type { Logger } from "../lib/logger";
import type { DeliveryJob, DeliveryService } from "../services/delivery-service";
import { TOKENS } from "../tokens";

// The SQS FIFO queue of deliveries (docs/api.md, "Delivery pipeline"). Resolved once at
// module scope (see create-request.ts).
const service = container.get<DeliveryService>(TOKENS.DeliveryService);
const logger = container.get<Logger>(TOKENS.Logger);

export const handler = async (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
  const log = logger.child({ awsRequestId: context.awsRequestId });

  const jobs: DeliveryJob[] = event.Records.map((record) => ({
    messageId: record.messageId,
    body: record.body,
    // SQS sends the count as a string. If it were ever not a number, NaN >= max is false, so
    // the message is simply never treated as the last attempt (it goes to the DLQ anyway).
    receiveCount: Number(record.attributes.ApproximateReceiveCount),
    // The trace of the request, put on the message by the enqueuer (absent on an older message).
    traceHeader: record.attributes.AWSTraceHeader,
  }));

  const result = await service.deliver(jobs, log);

  log.info("Delivery batch handled", { records: jobs.length, ...result.counts });

  // ReportBatchItemFailures: the messages listed here go back to the queue, all others
  // are deleted. The service decides which (see DeliveryService.deliver).
  return {
    batchItemFailures: result.failedMessageIds.map((itemIdentifier) => ({ itemIdentifier })),
  };
};
