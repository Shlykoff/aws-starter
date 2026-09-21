import type { Context } from "aws-lambda";
import type { ApiEvent } from "../../src/lib/http";

// Builders for API Gateway HTTP API (payload 2.0) events with a JWT authorizer. The
// values are fake: only `routeKey`, `body`, `pathParameters` and the `sub` claim matter
// to the code under test; the rest only makes the object a valid event.

interface EventOptions {
  routeKey: string;
  /** The `sub` claim of the (already verified) token. Ignored when `claims` is given. */
  sub?: string;
  /** Replaces the whole claims object, for example `{}` for a token without `sub`. */
  claims?: Record<string, string>;
  /** Builds an event that has no authorizer block at all. */
  withoutAuthorizer?: boolean;
  body?: string;
  isBase64Encoded?: boolean;
  pathParameters?: Record<string, string>;
}

function buildEvent(options: EventOptions): ApiEvent {
  const [method = "GET", path = "/"] = options.routeKey.split(" ");
  const claims = options.claims ?? { sub: options.sub ?? "user-a" };

  const authorizer = {
    principalId: "test",
    integrationLatency: 0,
    jwt: { claims, scopes: null },
  };

  return {
    version: "2.0",
    routeKey: options.routeKey,
    rawPath: path,
    rawQueryString: "",
    headers: { "content-type": "application/json" },
    requestContext: {
      accountId: "test-account",
      apiId: "test-api",
      domainName: "api.example.test",
      domainPrefix: "api",
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "192.0.2.1",
        userAgent: "vitest",
      },
      requestId: "test-gateway-request-id",
      routeKey: options.routeKey,
      stage: "$default",
      time: "20/Sep/2026:12:00:00 +0000",
      timeEpoch: 1789905600000,
      // A route deployed without the JWT authorizer has no `authorizer` block at all.
      ...(options.withoutAuthorizer ? {} : { authorizer }),
    },
    body: options.body,
    isBase64Encoded: options.isBase64Encoded ?? false,
    pathParameters: options.pathParameters,
  } as ApiEvent;
}

export const createRequestEvent = (
  options: { sub?: string; body?: string; isBase64Encoded?: boolean } = {},
): ApiEvent => buildEvent({ routeKey: "POST /requests", ...options });

export const listRequestsEvent = (options: { sub?: string } = {}): ApiEvent =>
  buildEvent({ routeKey: "GET /requests", ...options });

export const getRequestEvent = (options: { sub?: string; id?: string } = {}): ApiEvent =>
  buildEvent({
    routeKey: "GET /requests/{id}",
    sub: options.sub,
    pathParameters: options.id === undefined ? undefined : { id: options.id },
  });

export const retryRequestEvent = (options: { sub?: string; id?: string } = {}): ApiEvent =>
  buildEvent({
    routeKey: "POST /requests/{id}/retry",
    sub: options.sub,
    pathParameters: options.id === undefined ? undefined : { id: options.id },
  });

export const getExchangeEvent = (options: { sub?: string; id?: string } = {}): ApiEvent =>
  buildEvent({
    routeKey: "GET /requests/{id}/exchange",
    sub: options.sub,
    pathParameters: options.id === undefined ? undefined : { id: options.id },
  });

/** Same route, but the token has no `sub` claim (or no authorizer at all). */
export const eventWithoutSub = (
  routeKey: string,
  kind: "empty-claims" | "no-authorizer",
): ApiEvent =>
  buildEvent({
    routeKey,
    claims: {},
    withoutAuthorizer: kind === "no-authorizer",
    body: "{}",
  });

export function lambdaContext(awsRequestId = "test-lambda-request-id"): Context {
  return {
    awsRequestId,
    callbackWaitsForEmptyEventLoop: false,
    functionName: "test-function",
    functionVersion: "$LATEST",
    invokedFunctionArn: "arn:aws:lambda:eu-north-1:000000000000:function:test-function",
    memoryLimitInMB: "256",
    logGroupName: "/aws/lambda/test-function",
    logStreamName: "test-stream",
    getRemainingTimeInMillis: () => 10_000,
    done: () => undefined,
    fail: () => undefined,
    succeed: () => undefined,
  };
}
