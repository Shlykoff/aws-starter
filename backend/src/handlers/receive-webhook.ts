import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from "aws-lambda";
import { container } from "../container-webhook";
import { describeError } from "../lib/errors";
import type { Logger } from "../lib/logger";
import type { WebhookOutcome, WebhookService } from "../services/webhook-service";
import { TOKENS } from "../tokens";

// POST /webhooks/partner: the recipient tells us what the client did with a delivered request
// (contracts/webhook-api.md). The route is PUBLIC: no Cognito token, the signature is the
// authentication. Resolved once at module scope (see create-request.ts).
const service = container.get<WebhookService>(TOKENS.WebhookService);
const logger = container.get<Logger>(TOKENS.Logger);

// The ONE place where an outcome becomes an HTTP status. Ignored and repeated events are
// answered 200 on purpose: trying again would not change the answer. Every answer other than
// 200 has no body, and so has the 200 itself.
const STATUS_BY_OUTCOME: Record<WebhookOutcome, number> = {
  applied: 200,
  duplicate: 200,
  ignored: 200,
  too_large: 413,
  unauthorized: 401,
  unsupported_media: 415,
  malformed: 400,
  schema_invalid: 422,
  unknown_request: 404,
};

// API Gateway's HTTP API writes header names in lower case; the lookup ignores case anyway.
function header(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const found = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return found?.[1];
}

export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const log = logger.child({ awsRequestId: context.awsRequestId });

  // The signature covers the BYTES of the body, so they are taken exactly as they were sent:
  // API Gateway base64-encodes a body it treats as binary. A missing body is an empty one,
  // which fails a later check (401 or 400) as the contract's order says.
  const body = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8");

  try {
    const outcome = await service.receive(
      {
        body,
        timestampHeader: header(event, "x-webhook-timestamp"),
        signatureHeader: header(event, "x-webhook-signature"),
        contentType: header(event, "content-type"),
      },
      log,
    );
    return { statusCode: STATUS_BY_OUTCOME[outcome] };
  } catch (error) {
    // SSM, DynamoDB or a bug. 500 tells the recipient to try again later. Only the error's
    // type, message and stack are logged, never the event.
    log.error("Webhook failed", { outcome: "error", ...describeError(error) });
    return { statusCode: 500 };
  }
};
