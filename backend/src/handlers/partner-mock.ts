import type { Context, LambdaFunctionURLEvent } from "aws-lambda";
import { z } from "zod";
import { container } from "../container-mock";
import { ValidationError } from "../lib/errors";
import { jsonResponse, parseJsonBody } from "../lib/http";
import type { ApiResult } from "../lib/http";
import type { Logger } from "../lib/logger";
import { TOKENS } from "../tokens";

// A fake partner for the delivery pipeline (docs/api.md, "Partner webhook"). It sits behind
// a Lambda Function URL with auth type AWS_IAM: AWS checks the SigV4 signature before this
// code runs, so nothing here deals with authentication.
//
// The subject of the request decides the answer, which makes both kinds of failure easy
// to show in a demo. There is no state: the same request always gets the same answer.
const logger = container.get<Logger>(TOKENS.Logger);

const REJECT_MARKER = "[reject]";
const FAIL_MARKER = "[fail]";

// Only `subject` is looked at; other fields of the body are allowed and ignored.
const partnerBodySchema = z.object({ subject: z.string() });

function answerFor(subject: string): ApiResult {
  // If a subject has both markers, [reject] wins (it is checked first).
  if (subject.includes(REJECT_MARKER)) {
    return jsonResponse(422, { error: "The request was refused by the partner" });
  }
  if (subject.includes(FAIL_MARKER)) {
    return jsonResponse(503, { error: "The partner is temporarily unavailable" });
  }
  return jsonResponse(200, { accepted: true });
}

// Nothing in here waits for anything, so the handler is not `async`; it still returns a
// Promise because that is what the Lambda Node.js runtime expects.
export const handler = (event: LambdaFunctionURLEvent, context: Context): Promise<ApiResult> => {
  let response: ApiResult;
  try {
    const { subject } = parseJsonBody(event, partnerBodySchema);
    response = answerFor(subject);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    response = jsonResponse(400, { error: error.message });
  }

  // The body is not logged: it holds the request text. The Idempotency-Key is the request id.
  logger.info("Partner mock answered", {
    awsRequestId: context.awsRequestId,
    statusCode: response.statusCode,
    idempotencyKey: event.headers["idempotency-key"],
  });
  return Promise.resolve(response);
};
