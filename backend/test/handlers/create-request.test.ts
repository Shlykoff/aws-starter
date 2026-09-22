import { CognitoIdentityProviderClient, GetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../src/handlers/create-request";
import type { MissingSubKind } from "../helpers/events";
import { ACCESS_TOKEN, CORS_HEADERS, createRequestEvent, eventWithoutSub, lambdaContext } from "../helpers/events";
import { stubTable } from "../helpers/fake-table";
import type { FakeTable } from "../helpers/fake-table";
import { captureLogs } from "../helpers/logs";

// These tests run the real handler, service, repository and container. Only the AWS SDK's
// `send` is replaced (by an in-memory table, and Cognito's GetUser by a recorder), so no
// network and no credentials are used.
const ddb = mockClient(DynamoDBDocumentClient);
const cognito = mockClient(CognitoIdentityProviderClient);
const SENDER_EMAIL = "sender@example.test";
let table: FakeTable;
let logs: ReturnType<typeof captureLogs>;

beforeEach(() => {
  ddb.reset();
  cognito.reset();
  table = stubTable(ddb);
  cognito.on(GetUserCommand).resolves({ UserAttributes: [{ Name: "email", Value: SENDER_EMAIL }] });
  logs = captureLogs();
});
afterAll(() => {
  ddb.restore();
  cognito.restore();
});

const validBody = { subject: "Order 42", body: "Please ship." };
const call = (event = createRequestEvent({ body: JSON.stringify(validBody) })) =>
  handler(event, lambdaContext());
const json = (response: { body?: string }): unknown => JSON.parse(response.body ?? "null");

describe("POST /requests", () => {
  describe("201 Created", () => {
    it("returns the created request as JSON", async () => {
      const response = await call();

      expect(response.statusCode).toBe(201);
      expect(response.headers).toEqual({ "content-type": "application/json", ...CORS_HEADERS });
      expect(json(response)).toEqual({
        id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/) as string,
        ...validBody,
        status: "created",
        createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) as string,
      });
    });

    it("stores the request under the pk of the token's sub", async () => {
      const response = await call(createRequestEvent({ sub: "user-42", body: JSON.stringify(validBody) }));
      const { id } = json(response) as { id: string };

      expect(table.items()).toEqual([
        expect.objectContaining({ pk: "USER#user-42", sk: `REQ#${id}`, ...validBody, status: "created" }),
      ]);
    });

    it("does not return the owner or the storage keys", async () => {
      const response = await call(createRequestEvent({ sub: "user-42", body: JSON.stringify(validBody) }));

      expect(Object.keys(json(response) as object).sort()).toEqual(
        ["body", "createdAt", "id", "status", "subject"],
      );
      expect(response.body).not.toContain("user-42");
    });

    it("trims the values it stores", async () => {
      const body = { subject: " Order 42 ", body: "\nPlease ship.\n" };

      await call(createRequestEvent({ body: JSON.stringify(body) }));

      expect(table.items()[0]).toMatchObject(validBody);
    });

    it("accepts a base64-encoded body", async () => {
      const encoded = Buffer.from(JSON.stringify(validBody), "utf8").toString("base64");

      const response = await call(createRequestEvent({ body: encoded, isBase64Encoded: true }));

      expect(response.statusCode).toBe(201);
    });

    it("reads the access token from the Authorization header case-insensitively", async () => {
      const response = await call(
        createRequestEvent({ body: JSON.stringify(validBody), headers: { authorization: ACCESS_TOKEN } }),
      );

      expect(response.statusCode).toBe(201);
      expect(cognito.commandCalls(GetUserCommand)[0]?.args[0].input).toEqual({ AccessToken: ACCESS_TOKEN });
    });

    it("stores the caller's e-mail as senderEmail, never returned by the API", async () => {
      const response = await call(createRequestEvent({ body: JSON.stringify(validBody) }));

      expect(table.items()[0]).toMatchObject({ senderEmail: SENDER_EMAIL });
      expect(response.body).not.toContain(SENDER_EMAIL);
    });

    it("gives two requests two different ids", async () => {
      const first = json(await call()) as { id: string };
      const second = json(await call()) as { id: string };

      expect(first.id).not.toBe(second.id);
      expect(table.items()).toHaveLength(2);
    });
  });

  describe("400 validation_error", () => {
    const expectValidationError = async (event: ReturnType<typeof createRequestEvent>) => {
      const response = await call(event);

      expect(response.statusCode).toBe(400);
      // The error response carries the CORS header too: a browser could not read it otherwise.
      expect(response.headers).toEqual({ "content-type": "application/json", ...CORS_HEADERS });
      const payload = json(response) as { error: { code: string; message: string; details?: unknown } };
      expect(payload.error.code).toBe("validation_error");
      // Nothing may be written for a request that failed validation.
      expect(ddb.calls()).toHaveLength(0);
      return payload;
    };

    it("rejects a body that is not valid JSON", async () => {
      const payload = await expectValidationError(createRequestEvent({ body: "{oops" }));

      expect(payload.error.message).toBe("Request body must be valid JSON");
    });

    it("rejects a missing body", async () => {
      const payload = await expectValidationError(createRequestEvent({}));

      expect(payload.error.message).toBe("Request body is required");
    });

    it("says which field is invalid", async () => {
      const body = JSON.stringify({ ...validBody, subject: "x".repeat(201), body: "" });

      const payload = await expectValidationError(createRequestEvent({ body }));

      const paths = (payload.error.details as { path: string }[]).map((detail) => detail.path);
      expect(paths.sort()).toEqual(["body", "subject"]);
    });

    it("rejects a partner field: there is exactly one recipient now", async () => {
      const body = JSON.stringify({ ...validBody, partner: "Acme" });

      const payload = await expectValidationError(createRequestEvent({ body }));

      expect(payload.error.message).toBe("Request body is invalid");
    });

    it("rejects a body that is too long", async () => {
      const body = JSON.stringify({ ...validBody, body: "x".repeat(5001) });

      await expectValidationError(createRequestEvent({ body }));
    });

    it("rejects a JSON body that is not an object", async () => {
      await expectValidationError(createRequestEvent({ body: "[]" }));
      await expectValidationError(createRequestEvent({ body: "null" }));
    });

    it("rejects an owner sent by the client instead of ignoring it", async () => {
      const body = JSON.stringify({ ...validBody, owner: "user-b", pk: "USER#user-b" });

      await expectValidationError(createRequestEvent({ sub: "user-a", body }));
    });
  });

  describe("500 internal_error", () => {
    it("fails when the token has no sub claim, and writes nothing", async () => {
      const kinds: MissingSubKind[] = ["empty-claims", "no-claims", "empty-sub", "no-authorizer"];
      for (const kind of kinds) {
        const response = await call(eventWithoutSub("POST /requests", kind));

        expect(response.statusCode).toBe(500);
        expect(response.headers).toEqual({ "content-type": "application/json", ...CORS_HEADERS });
        expect(json(response)).toEqual({
          error: { code: "internal_error", message: "Internal server error" },
        });
      }
      expect(ddb.calls()).toHaveLength(0);
      expect(logs.entries()).toContainEqual(
        expect.objectContaining({ level: "error", errorMessage: "Cognito authorizer did not provide a sub claim" }),
      );
    });

    it("fails when there is no Authorization header, and writes nothing", async () => {
      const response = await call(createRequestEvent({ body: JSON.stringify(validBody), headers: null }));

      expect(response.statusCode).toBe(500);
      expect(json(response)).toEqual({
        error: { code: "internal_error", message: "Internal server error" },
      });
      expect(ddb.calls()).toHaveLength(0);
      expect(cognito.commandCalls(GetUserCommand)).toHaveLength(0);
      expect(logs.entries()).toContainEqual(
        expect.objectContaining({ level: "error", errorMessage: "Authorization header missing on an authorized route" }),
      );
    });

    it("hides the cause when Cognito's GetUser fails, but logs it, and writes nothing", async () => {
      cognito.on(GetUserCommand).rejects(new Error("NotAuthorizedException: Access Token has expired"));

      const response = await call();

      expect(response.statusCode).toBe(500);
      expect(json(response)).toEqual({
        error: { code: "internal_error", message: "Internal server error" },
      });
      expect(ddb.calls()).toHaveLength(0);
      expect(logs.entries()).toContainEqual(
        expect.objectContaining({
          level: "error",
          errorMessage: "NotAuthorizedException: Access Token has expired",
        }),
      );
    });

    it("hides the cause when Cognito has no email attribute for the caller, and writes nothing", async () => {
      cognito.on(GetUserCommand).resolves({ UserAttributes: [{ Name: "sub", Value: "user-a" }] });

      const response = await call();

      expect(response.statusCode).toBe(500);
      expect(ddb.calls()).toHaveLength(0);
      expect(logs.entries()).toContainEqual(
        expect.objectContaining({
          level: "error",
          errorMessage: "Cognito returned no email attribute for the caller",
        }),
      );
    });

    it("hides the cause when DynamoDB fails, but logs it", async () => {
      ddb.on(PutCommand).rejects(new Error("ProvisionedThroughputExceededException: table demo-secret"));

      const response = await call();

      expect(response.statusCode).toBe(500);
      expect(json(response)).toEqual({
        error: { code: "internal_error", message: "Internal server error" },
      });
      expect(logs.entries()).toContainEqual(
        expect.objectContaining({
          level: "error",
          errorMessage: "ProvisionedThroughputExceededException: table demo-secret",
        }),
      );
    });
  });

  describe("logging", () => {
    it("writes one summary line with route, status, duration and request id", async () => {
      await handler(createRequestEvent({ body: JSON.stringify(validBody) }), lambdaContext("req-77"));

      expect(logs.entries().filter((line) => line.message === "Request handled")).toEqual([
        {
          level: "info",
          message: "Request handled",
          awsRequestId: "req-77",
          route: "POST /requests",
          statusCode: 201,
          durationMs: expect.any(Number) as number,
        },
      ]);
    });

    it("writes the request_created event with the Lambda request id, and only for a stored request", async () => {
      await handler(createRequestEvent({ body: JSON.stringify(validBody) }), lambdaContext("req-78"));
      await handler(createRequestEvent({ body: "{" }), lambdaContext("req-79")); // 400: nothing stored

      expect(logs.entries().filter((line) => line.message === "Request event")).toEqual([
        {
          level: "info",
          message: "Request event",
          awsRequestId: "req-78",
          event: "request_created",
          role: "user",
          requestId: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/) as string,
          toStatus: "created",
        },
      ]);
    });

    it("never writes the request body or the user id to the logs", async () => {
      const secret = "TOP-SECRET-BODY-MARKER";
      const body = JSON.stringify({ subject: "S-MARKER", body: secret });

      await call(createRequestEvent({ sub: "user-sub-marker", body }));
      await call(createRequestEvent({ sub: "user-sub-marker", body: `${body}{` })); // 400
      ddb.on(PutCommand).rejects(new Error("boom"));
      await call(createRequestEvent({ sub: "user-sub-marker", body })); // 500

      const everything = logs.lines.join("\n");
      expect(logs.lines.length).toBeGreaterThan(3);
      for (const marker of [secret, "S-MARKER", "user-sub-marker", SENDER_EMAIL]) {
        expect(everything).not.toContain(marker);
      }
    });
  });
});
