import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { ulid } from "ulid";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { handler as createHandler } from "../../src/handlers/create-request";
import { handler as listHandler } from "../../src/handlers/list-requests";
import { createRequestEvent, eventWithoutSub, lambdaContext, listRequestsEvent } from "../helpers/events";
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

const list = (sub = "user-a") => listHandler(listRequestsEvent({ sub }), lambdaContext());
const json = (response: { body?: string }): unknown => JSON.parse(response.body ?? "null");

// Writes a request straight into the table with a ULID from a chosen moment, so the
// order does not depend on how fast the test runs.
function seedRequest(sub: string, minute: number, subject: string) {
  const id = ulid(Date.UTC(2026, 8, 20, 12, minute));
  const request = {
    id,
    partner: "Acme",
    subject,
    body: "text",
    status: "created",
    createdAt: new Date(Date.UTC(2026, 8, 20, 12, minute)).toISOString(),
  };
  table.seed({ pk: `USER#${sub}`, sk: `REQ#${id}`, ...request });
  return request;
}

describe("GET /requests", () => {
  it("returns 200 and an empty list for a user without requests", async () => {
    const response = await list();

    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual({ "content-type": "application/json" });
    expect(json(response)).toEqual({ items: [] });
  });

  it("returns the user's requests, newest first", async () => {
    const oldest = seedRequest("user-a", 1, "oldest");
    const newest = seedRequest("user-a", 3, "newest");
    const middle = seedRequest("user-a", 2, "middle");

    const response = await list();

    expect(json(response)).toEqual({ items: [newest, middle, oldest] });
  });

  it("returns at most 50 requests: the 50 newest", async () => {
    // 60 requests, one per minute from 12:00 to 12:59.
    const all = Array.from({ length: 60 }, (_, minute) => seedRequest("user-a", minute, `r${minute}`));

    const response = await list();

    const { items } = json(response) as { items: { subject: string }[] };
    expect(items).toHaveLength(50);
    expect(items[0]).toEqual(all[59]);
    expect(items[49]).toEqual(all[10]);
  });

  it("does not return other users' requests", async () => {
    const mine = seedRequest("user-a", 1, "mine");
    seedRequest("user-b", 2, "theirs");

    const response = await list("user-a");

    expect(json(response)).toEqual({ items: [mine] });
    expect(response.body).not.toContain("theirs");
  });

  it("shows a request that was just created through the API", async () => {
    const created = await createHandler(
      createRequestEvent({ body: JSON.stringify({ partner: "Acme", subject: "S", body: "B" }) }),
      lambdaContext(),
    );

    const response = await list();

    expect(json(response)).toEqual({ items: [json(created)] });
  });

  it("queries the user's partition newest first with a limit of 50", async () => {
    await list("user-a");

    expect(ddb.commandCalls(QueryCommand).map((call) => call.args[0].input)).toEqual([
      expect.objectContaining({
        ExpressionAttributeValues: { ":pk": "USER#user-a" },
        ScanIndexForward: false,
        Limit: 50,
      }),
    ]);
  });

  it("fails with 500 when the token has no sub claim, without querying", async () => {
    const response = await listHandler(eventWithoutSub("GET /requests", "empty-claims"), lambdaContext());

    expect(response.statusCode).toBe(500);
    expect(json(response)).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
    expect(ddb.calls()).toHaveLength(0);
  });

  it("returns 500 without details when DynamoDB fails", async () => {
    ddb.on(QueryCommand).rejects(new Error("ServiceUnavailable"));

    const response = await list();

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("ServiceUnavailable");
    expect(logs.entries()).toContainEqual(
      expect.objectContaining({ level: "error", errorMessage: "ServiceUnavailable" }),
    );
  });

  it("logs the route and status code", async () => {
    await list();

    expect(logs.entries()).toEqual([
      expect.objectContaining({
        route: "GET /requests",
        statusCode: 200,
        awsRequestId: "test-lambda-request-id",
      }),
    ]);
  });
});
