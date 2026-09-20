import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
  Context,
} from "aws-lambda";
import type { z } from "zod";
import { AppError, MisconfigurationError, ValidationError } from "./errors";
import type { ErrorCode } from "./errors";
import type { Logger } from "./logger";

// API Gateway HTTP API, payload format 2.0, with a JWT authorizer in front (docs/api.md).
export type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer;
export type ApiResult = APIGatewayProxyStructuredResultV2;

export function jsonResponse(statusCode: number, body: unknown): ApiResult {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

// The ONE place where error codes become HTTP status codes.
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  validation_error: 400,
  not_found: 404,
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
 * The owner of the request: the `sub` claim that API Gateway's JWT authorizer verified.
 * This is the only source of the owner. Nothing the client sends is ever used for it.
 */
export function getOwnerId(event: ApiEvent): string {
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== "string" || sub === "") {
    // A protected route must always carry the claim. If it does not, the API Gateway
    // route or authorizer is misconfigured: that is our fault, so it is a 500.
    throw new MisconfigurationError("JWT authorizer did not provide a sub claim");
  }
  return sub;
}

/** Parses the JSON body and validates it against a zod schema; throws ValidationError. */
export function parseJsonBody<T>(event: ApiEvent, schema: z.ZodType<T>): T {
  if (event.body === undefined || event.body === "") {
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
 * `run` only has to return the success response.
 */
export function createHandler(
  logger: Logger,
  run: (event: ApiEvent) => Promise<ApiResult>,
): (event: ApiEvent, context: Context) => Promise<ApiResult> {
  return async (event, context) => {
    const startedAt = Date.now();
    const requestLogger = logger.child({ awsRequestId: context.awsRequestId });

    let response: ApiResult;
    try {
      response = await run(event);
    } catch (error) {
      response = toErrorResponse(error);
      if (response.statusCode === STATUS_BY_CODE.internal_error) {
        // Log what went wrong (error type, message, stack) but never the event or body.
        requestLogger.error("Request failed", describeError(error));
      }
    }

    requestLogger.info("Request handled", {
      route: event.routeKey,
      statusCode: response.statusCode,
      durationMs: Date.now() - startedAt,
    });
    return response;
  };
}

function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message, stack: error.stack };
  }
  return { errorName: "NonError", errorMessage: String(error) };
}
