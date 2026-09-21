import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { ulid } from "ulid";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../src/handlers/get-request";
import { CORS_HEADERS, eventWithoutSub, getRequestEvent, lambdaContext } from "../helpers/events";
import { stubTable } from "../helpers/fake-table";
import type { FakeTable } from "../helpers/fake-table";
import { captureLogs } from "../helpers/logs";

const ddb = mockClient(DynamoDBDocumentClient);
let table: FakeTable;
let logs: ReturnType<typeof captureLogs>;

beforeEach(() => {
  ddb.reset();
  table = stubTable(ddb);
  logs = captureLogs();
});
afterAll(() => {
  ddb.restore();
});

const ID = ulid(Date.UTC(2026, 8, 20, 12, 0));
const stored = {
  id: ID,
  partner: "Acme",
  subject: "Order 42",
  body: "Please ship.",
  status: "created",
  createdAt: "2026-09-20T12:00:00.000Z",
};
const get = (options: { sub?: string; id?: string }) => handler(getRequestEvent(options), lambdaContext());
const json = (response: { body?: string }): unknown => JSON.parse(response.body ?? "null");
const notFound = { error: { code: "not_found", message: "Request not found" } };

describe("GET /requests/{id}", () => {
  it("returns 200 and the request without owner or keys", async () => {
    table.seed({ pk: "USER#user-a", sk: `REQ#${ID}`, ...stored });

    const response = await get({ sub: "user-a", id: ID });

    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual({ "content-type": "application/json", ...CORS_HEADERS });
    expect(json(response)).toEqual(stored);
    expect(response.body).not.toContain("user-a");
  });

  it("reads the item by the token's sub and the id from the path", async () => {
    await get({ sub: "user-a", id: ID });

    expect(ddb.commandCalls(GetCommand).map((call) => call.args[0].input.Key)).toEqual([
      { pk: "USER#user-a", sk: `REQ#${ID}` },
    ]);
  });

  it("returns 404 for an id that does not exist", async () => {
    const response = await get({ sub: "user-a", id: ID });

    expect(response.statusCode).toBe(404);
    expect(json(response)).toEqual(notFound);
  });

  it("returns 404 for an id that is not a ULID, without reading the table", async () => {
    for (const id of ["nope", "../../etc", "x".repeat(3000)]) {
      const response = await get({ sub: "user-a", id });

      expect(response.statusCode).toBe(404);
      expect(json(response)).toEqual(notFound);
    }
    expect(ddb.calls()).toHaveLength(0);
  });

  it("returns 404 if the path parameter is missing altogether", async () => {
    const response = await get({ sub: "user-a" });

    expect(response.statusCode).toBe(404);
    expect(ddb.calls()).toHaveLength(0);
  });

  it("fails with 500 when the token has no sub claim, without reading", async () => {
    const response = await handler(eventWithoutSub("GET /requests/{id}", "no-authorizer"), lambdaContext());

    expect(response.statusCode).toBe(500);
    expect(response.headers).toMatchObject(CORS_HEADERS);
    expect(json(response)).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
    expect(ddb.calls()).toHaveLength(0);
  });

  it("returns 500 without details when DynamoDB fails", async () => {
    ddb.on(GetCommand).rejects(new Error("ServiceUnavailable"));

    const response = await get({ sub: "user-a", id: ID });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("ServiceUnavailable");
    expect(logs.entries()).toContainEqual(
      expect.objectContaining({ level: "error", errorMessage: "ServiceUnavailable" }),
    );
  });

  it("logs the route template, not the id", async () => {
    await get({ sub: "user-a", id: ID });

    expect(logs.entries()).toEqual([
      expect.objectContaining({ route: "GET /requests/{id}", statusCode: 404 }),
    ]);
  });
});
