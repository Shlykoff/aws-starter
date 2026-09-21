import type { CloudWatchLogsEvent, Context } from "aws-lambda";
import { container } from "../container-archiver";
import type { Logger } from "../lib/logger";
import type { LogArchiveService } from "../services/log-archive-service";
import { TOKENS } from "../tokens";

// A CloudWatch Logs subscription filter calls this function, asynchronously, with a batch of
// log events; the function copies it to S3 (the log archive). Resolved once at module scope
// (see create-request.ts).
const service = container.get<LogArchiveService>(TOKENS.LogArchiveService);
const logger = container.get<Logger>(TOKENS.Logger);

export const handler = async (event: CloudWatchLogsEvent, context: Context): Promise<void> => {
  const log = logger.child({ awsRequestId: context.awsRequestId });

  // `awslogs.data` is the batch: base64 of gzipped JSON. The service reads it.
  await service.archive(event.awslogs.data, log);
};
