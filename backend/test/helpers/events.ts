import type { Context } from "aws-lambda";
import type { ApiEvent } from "../../src/lib/http";

// Builders for API Gateway REST API events (Lambda proxy integration, payload 1.0). The values
// are fake: the code under test reads `httpMethod`, `resource`, `headers`, `body`,
// `pathParameters` and the `sub` claim of the Cognito authorizer; the rest only makes the
// object a valid event.

/** The header that every response of the API carries (src/lib/http.ts). */
export const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

/** A fake Cognito access token: the raw value create-request reads from the Authorization
 * header (never a Bearer-prefixed one; docs/api.md). */
export const ACCESS_TOKEN = "test-access-token";

export interface RestEventOptions {
  httpMethod: string;
  /** The route template, as API Gateway puts it in `resource`: "/requests/{id}". */
  resource: string;
  pathParameters?: Record<string, string>;
  /**
   * The headers as the sender wrote them (a REST API keeps their case). Default: a JSON content
   * type. `null` builds an event whose `headers` is null, which the type does not allow but
   * API Gateway can send (a test invocation with no headers).
   */
  headers?: Record<string, string> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  /** Replaces the `authorizer` block; `undefined` leaves it out (a route without an authorizer). */
  authorizer?: Record<string, unknown>;
  requestTimeEpoch?: number;
}

/** The path of the request: the template with every {name} replaced by its value. */
function pathOf(resource: string, pathParameters: Record<string, string> | undefined): string {
  return resource.replace(/\{(\w+)\}/g, (whole, name: string) => pathParameters?.[name] ?? whole);
}

export function restEvent(options: RestEventOptions): ApiEvent {
  const path = pathOf(options.resource, options.pathParameters);
  const headers =
    options.headers === undefined ? { "Content-Type": "application/json" } : options.headers;
  const multiValueHeaders = Object.fromEntries(
    Object.entries(headers ?? {}).map(([name, value]) => [name, [value]]),
  );

  return {
    resource: options.resource,
    path,
    httpMethod: options.httpMethod,
    headers: headers as ApiEvent["headers"],
    multiValueHeaders,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: options.pathParameters ?? null,
    stageVariables: null,
    requestContext: {
      accountId: "000000000000",
      apiId: "test-api",
      domainName: "api.example.test",
      domainPrefix: "api",
      extendedRequestId: "test-extended-request-id",
      httpMethod: options.httpMethod,
      identity: {
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        sourceIp: "192.0.2.1",
        user: null,
        userAgent: "vitest",
        userArn: null,
      },
      path: `/v1${path}`, // the stage name comes first here, unlike in `path`
      protocol: "HTTP/1.1",
      requestId: "test-gateway-request-id",
      requestTime: "20/Sep/2026:12:00:00 +0000",
      requestTimeEpoch: options.requestTimeEpoch ?? 1_789_905_600_000,
      resourceId: "test-resource",
      resourcePath: options.resource,
      stage: "v1",
      authorizer: options.authorizer,
    },
    body: options.body ?? null,
    isBase64Encoded: options.isBase64Encoded ?? false,
  };
}

interface EventOptions {
  /** "POST /requests/{id}/retry": the method and the route template. */
  route: string;
  /** The `sub` claim of the (already verified) token. Ignored when `claims` or `authorizer` is given. */
  sub?: string;
  /** Replaces the whole claims object, for example `{}` for a token without `sub`. */
  claims?: Record<string, unknown>;
  /** Replaces the whole `authorizer` block. "none": an event that has no authorizer block at all. */
  authorizer?: Record<string, unknown> | "none";
  body?: string;
  headers?: Record<string, string> | null;
  isBase64Encoded?: boolean;
  pathParameters?: Record<string, string>;
}

function buildEvent(options: EventOptions): ApiEvent {
  const [httpMethod = "GET", resource = "/"] = options.route.split(" ");
  // What a Cognito user pool authorizer puts in the event: the claims of the verified ID token.
  const claims = options.claims ?? { sub: options.sub ?? "user-a", token_use: "id" };

  return restEvent({
    httpMethod,
    resource,
    pathParameters: options.pathParameters,
    headers: options.headers,
    body: options.body,
    isBase64Encoded: options.isBase64Encoded,
    authorizer: options.authorizer === "none" ? undefined : (options.authorizer ?? { claims }),
  });
}

export const createRequestEvent = (
  options: {
    sub?: string;
    body?: string;
    isBase64Encoded?: boolean;
    headers?: Record<string, string> | null;
  } = {},
): ApiEvent =>
  buildEvent({
    route: "POST /requests",
    ...options,
    // A real request always carries Authorization (the authorizer needed it to run at all), so
    // tests get it by default; a test of a missing token passes `headers: null` or its own map.
    headers: options.headers === undefined ? { Authorization: ACCESS_TOKEN } : options.headers,
  });

export const listRequestsEvent = (options: { sub?: string } = {}): ApiEvent =>
  buildEvent({ route: "GET /requests", ...options });

export const getRequestEvent = (options: { sub?: string; id?: string } = {}): ApiEvent =>
  buildEvent({
    route: "GET /requests/{id}",
    sub: options.sub,
    pathParameters: options.id === undefined ? undefined : { id: options.id },
  });

export const retryRequestEvent = (options: { sub?: string; id?: string } = {}): ApiEvent =>
  buildEvent({
    route: "POST /requests/{id}/retry",
    sub: options.sub,
    pathParameters: options.id === undefined ? undefined : { id: options.id },
  });

export const getExchangeEvent = (options: { sub?: string; id?: string } = {}): ApiEvent =>
  buildEvent({
    route: "GET /requests/{id}/exchange",
    sub: options.sub,
    pathParameters: options.id === undefined ? undefined : { id: options.id },
  });

/** The ways a protected route can arrive without a usable caller id. */
export type MissingSubKind = "empty-claims" | "no-claims" | "empty-sub" | "no-authorizer";

/** Same route, but the token has no usable `sub` claim (or there is no authorizer block at all). */
export const eventWithoutSub = (route: string, kind: MissingSubKind): ApiEvent =>
  buildEvent({
    route,
    body: "{}",
    ...(kind === "empty-claims" && { claims: {} }),
    ...(kind === "empty-sub" && { claims: { sub: "" } }),
    ...(kind === "no-claims" && { authorizer: { principalId: "test" } }),
    ...(kind === "no-authorizer" && { authorizer: "none" as const }),
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
