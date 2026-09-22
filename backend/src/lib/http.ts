import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";
import type { z } from "zod";
import { AppError, MisconfigurationError, ValidationError, describeError } from "./errors";
import type { ErrorCode } from "./errors";
import type { Logger } from "./logger";

// API Gateway REST API, Lambda proxy integration (payload format 1.0), with a Cognito user pool
// authorizer in front (docs/api.md). The plain event type on purpose: its `authorizer` is loosely
// typed, so `getOwnerId` has to check the claim instead of trusting a type that says "always there".
export type ApiEvent = APIGatewayProxyEvent;
export type ApiResult = APIGatewayProxyResult;

// With a proxy integration the gateway adds NO header to what the function returns, so the CORS
// header is ours to write, and it is written here, on every response, error responses included:
// a browser that is refused CORS on a 404 or a 500 cannot even read the error. "*" is safe because
// the API is authorized by a bearer token in the `Authorization` header, never by a cookie: a page
// of another origin has no token to send. (The preflight OPTIONS request is answered by the
// gateway itself, not by these functions.)
const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

// The one place where a response is built, so that none can be built without the CORS header
// (it comes last: a route cannot replace it by passing a header of the same name).
function buildResponse(statusCode: number, body: string, headers: Record<string, string>): ApiResult {
  return { statusCode, headers: { ...headers, ...CORS_HEADERS }, body };
}

export function jsonResponse(
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): ApiResult {
  return buildResponse(statusCode, JSON.stringify(body), {
    "content-type": "application/json",
    ...extraHeaders,
  });
}

/** A response with no body: the answer of the webhook (only a status code) and a 204. */
export function emptyResponse(statusCode: number, extraHeaders: Record<string, string> = {}): ApiResult {
  return buildResponse(statusCode, "", extraHeaders);
}

// The ONE place where error codes become HTTP status codes.
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  validation_error: 400,
  not_found: 404,
  not_retryable: 409,
  internal_error: 500,
};

// What clients see for a 500: nothing about the cause. Details go to the logs only.
const INTERNAL_ERROR_MESSAGE = "Internal server error";

// Anything that is not an AppError (an SDK failure, a bug) is an internal error.
function toErrorResponse(error: unknown): ApiResult {
  if (error instanceof AppError && error.code !== "internal_error") {
    return jsonResponse(STATUS_BY_CODE[error.code], {
      error: { code: error.code, message: error.message, details: error.details },
    });
  }
  return jsonResponse(STATUS_BY_CODE.internal_error, {
    error: { code: "internal_error", message: INTERNAL_ERROR_MESSAGE },
  });
}

/**
 * The owner of the request: the `sub` claim that API Gateway's Cognito authorizer verified (it
 * arrives in `requestContext.authorizer.claims`). This is the only source of the owner. Nothing
 * the client sends is ever used for it.
 */
export function getOwnerId(event: ApiEvent): string {
  // The type of `authorizer` is loosely typed (`any` inside): take the claims as `unknown` and
  // check every step. No authorizer block, no `claims` and no `sub` all end in the same error.
  const claims: unknown = event.requestContext.authorizer?.claims;
  const sub = typeof claims === "object" && claims !== null && "sub" in claims ? claims.sub : undefined;
  if (typeof sub !== "string" || sub === "") {
    // A protected route must always carry the claim. If it does not, the API Gateway
    // method or authorizer is misconfigured: that is our fault, so it is a 500.
    throw new MisconfigurationError("Cognito authorizer did not provide a sub claim");
  }
  return sub;
}

/**
 * A header value, found case-insensitively: a REST API keeps header names exactly as the sender
 * wrote them ("X-Webhook-Signature", or "x-webhook-signature", whatever the sender's HTTP
 * library does). `name` must already be lower case. `headers` can be null when the sender sent
 * none, although the type says it cannot.
 */
export function getHeader(event: Pick<ApiEvent, "headers">, name: string): string | undefined {
  const found = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return found?.[1];
}

/** Parses the JSON body and validates it against a zod schema; throws ValidationError. */
export function parseJsonBody<T>(
  event: Pick<ApiEvent, "body" | "isBase64Encoded">,
  schema: z.ZodType<T>,
): T {
  // A REST API event has `body: null` when the client sent none.
  if (event.body === null || event.body === "") {
    throw new ValidationError("Request body is required");
  }

  // API Gateway base64-encodes the body for some content types.
  const text = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ValidationError(
      "Request body is invalid",
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/**
 * Wraps the code of one route into a Lambda handler. It is the same for every route:
 *   - errors thrown by `run` become the JSON error shape of docs/api.md,
 *   - one log line per request: route, status code, duration and the Lambda request id.
 * `run` only has to return the success response. It gets the logger of this invocation (with the
 * Lambda request id) for the lines the route itself writes, such as the request events.
 */
export function createHandler(
  logger: Logger,
  run: (event: ApiEvent, log: Logger) => Promise<ApiResult>,
): (event: ApiEvent, context: Context) => Promise<ApiResult> {
  return async (event, context) => {
    const startedAt = Date.now();
    const requestLogger = logger.child({ awsRequestId: context.awsRequestId });

    let response: ApiResult;
    try {
      response = await run(event, requestLogger);
    } catch (error) {
      response = toErrorResponse(error);
      if (response.statusCode === STATUS_BY_CODE.internal_error) {
        // Log what went wrong (error type, message, stack) but never the event or body.
        requestLogger.error("Request failed", describeError(error));
      }
    }

    requestLogger.info("Request handled", {
      // The template, never the real path: "POST /requests/{id}/retry", not "POST /requests/01ABC...".
      route: `${event.httpMethod} ${event.resource}`,
      statusCode: response.statusCode,
      durationMs: Date.now() - startedAt,
    });
    return response;
  };
}
