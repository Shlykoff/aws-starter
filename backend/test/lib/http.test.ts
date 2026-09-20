import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NotFoundError, ValidationError, MisconfigurationError } from "../../src/lib/errors";
import { createHandler, getOwnerId, jsonResponse, parseJsonBody } from "../../src/lib/http";
import { createLogger } from "../../src/lib/logger";
import { createRequestEvent, eventWithoutSub, lambdaContext, listRequestsEvent } from "../helpers/events";
import { captureLogs } from "../helpers/logs";

describe("jsonResponse", () => {
  it("builds an API Gateway v2 response with a JSON body", () => {
    expect(jsonResponse(201, { ok: true })).toEqual({
      statusCode: 201,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    });
  });
});

describe("getOwnerId", () => {
  it("returns the sub claim of the verified token", () => {
    expect(getOwnerId(listRequestsEvent({ sub: "user-42" }))).toBe("user-42");
  });

  it("throws a misconfiguration error when the claims have no sub", () => {
    expect(() => getOwnerId(eventWithoutSub("GET /requests", "empty-claims"))).toThrow(
      MisconfigurationError,
    );
  });

  it("throws a misconfiguration error when the route has no authorizer at all", () => {
    expect(() => getOwnerId(eventWithoutSub("GET /requests", "no-authorizer"))).toThrow(
      MisconfigurationError,
    );
  });
});

describe("parseJsonBody", () => {
  const schema = z.strictObject({ name: z.string().min(1) });
  const parse = (body: string | undefined, isBase64Encoded = false) =>
    parseJsonBody(createRequestEvent({ body, isBase64Encoded }), schema);

  it("returns the parsed body", () => {
    expect(parse('{"name":"x"}')).toEqual({ name: "x" });
  });

  it("decodes a base64 body", () => {
    const encoded = Buffer.from('{"name":"x"}', "utf8").toString("base64");
    expect(parse(encoded, true)).toEqual({ name: "x" });
  });

  it("rejects a missing or empty body", () => {
    expect(() => parse(undefined)).toThrow(new ValidationError("Request body is required"));
    expect(() => parse("")).toThrow(new ValidationError("Request body is required"));
  });

  it("rejects invalid JSON", () => {
    expect(() => parse("{not json")).toThrow(new ValidationError("Request body must be valid JSON"));
  });

  it("reports which field is wrong, without echoing the value", () => {
    let error: unknown;
    try {
      parse('{"name":""}');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ValidationError);
    const { details } = error as ValidationError;
    expect(details).toEqual([{ path: "name", message: expect.any(String) as string }]);
  });
});

describe("createHandler", () => {
  const context = lambdaContext("lambda-id-1");
  const logger = createLogger("info");

  it("returns the response of the route and logs route, status and duration", async () => {
    const logs = captureLogs();
    const handler = createHandler(logger, () => Promise.resolve(jsonResponse(200, { items: [] })));

    const response = await handler(listRequestsEvent(), context);

    expect(response.statusCode).toBe(200);
    expect(logs.entries()).toEqual([
      {
        level: "info",
        message: "Request handled",
        awsRequestId: "lambda-id-1",
        route: "GET /requests",
        statusCode: 200,
        durationMs: expect.any(Number) as number,
      },
    ]);
  });

  it("maps a ValidationError to 400 validation_error with its details", async () => {
    captureLogs();
    const handler = createHandler(logger, () => {
      throw new ValidationError("bad", [{ path: "partner", message: "too short" }]);
    });

    const response = await handler(listRequestsEvent(), context);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body ?? "")).toEqual({
      error: {
        code: "validation_error",
        message: "bad",
        details: [{ path: "partner", message: "too short" }],
      },
    });
  });

  it("maps a NotFoundError to 404 not_found", async () => {
    captureLogs();
    const handler = createHandler(logger, () => Promise.reject(new NotFoundError()));

    const response = await handler(listRequestsEvent(), context);

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body ?? "")).toEqual({
      error: { code: "not_found", message: "Request not found" },
    });
  });

  it("maps a MisconfigurationError to a generic 500 and logs the real reason", async () => {
    const logs = captureLogs();
    const handler = createHandler(logger, () => {
      throw new MisconfigurationError("JWT authorizer did not provide a sub claim");
    });

    const response = await handler(listRequestsEvent(), context);

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body ?? "")).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
    expect(logs.entries()[0]).toMatchObject({
      level: "error",
      errorName: "MisconfigurationError",
      errorMessage: "JWT authorizer did not provide a sub claim",
    });
  });

  it("maps an unexpected error to a generic 500 that does not leak its message", async () => {
    const logs = captureLogs();
    const handler = createHandler(logger, () =>
      Promise.reject(new Error("AccessDeniedException: arn:aws:dynamodb:secret-table")),
    );

    const response = await handler(listRequestsEvent(), context);

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("AccessDenied");
    expect(response.body).not.toContain("secret-table");
    expect(logs.entries()[0]).toMatchObject({
      level: "error",
      errorMessage: "AccessDeniedException: arn:aws:dynamodb:secret-table",
    });
    // Still one summary line per request, with the final status code.
    expect(logs.entries()[1]).toMatchObject({ message: "Request handled", statusCode: 500 });
  });

  it("copes with something that is not an Error being thrown", async () => {
    captureLogs();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of this test
    const handler = createHandler(logger, () => Promise.reject("just a string"));

    const response = await handler(listRequestsEvent(), context);

    expect(response.statusCode).toBe(500);
  });
});
