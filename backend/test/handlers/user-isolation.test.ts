import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { ulid } from "ulid";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { handler as create } from "../../src/handlers/create-request";
import { handler as get } from "../../src/handlers/get-request";
import { handler as list } from "../../src/handlers/list-requests";
import { createRequestEvent, getRequestEvent, lambdaContext, listRequestsEvent } from "../helpers/events";
import { stubTable } from "../helpers/fake-table";
import { captureLogs } from "../helpers/logs";

// The central security property of the API: what one user creates, no other user can see.
// User A and user B are two different `sub` claims. The handlers, service, repository and
// container are the real ones; only DynamoDB is an in-memory table with real key rules.
const ddb = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddb.reset();
  stubTable(ddb);
  captureLogs();
});
afterAll(() => {
  ddb.restore();
});

const context = lambdaContext();
const json = (response: { body?: string }): unknown => JSON.parse(response.body ?? "null");

async function createAs(sub: string, subject: string) {
  const body = JSON.stringify({ partner: "Acme", subject, body: "private text" });
  const response = await create(createRequestEvent({ sub, body }), context);
  expect(response.statusCode).toBe(201);
  return json(response) as { id: string };
}

describe("user isolation", () => {
  it("user B cannot read user A's request by id: 404, exactly like a request that does not exist", async () => {
    const requestOfA = await createAs("user-a", "A's secret subject");

    const asA = await get(getRequestEvent({ sub: "user-a", id: requestOfA.id }), context);
    const asB = await get(getRequestEvent({ sub: "user-b", id: requestOfA.id }), context);
    const unknown = await get(getRequestEvent({ sub: "user-b", id: ulid(1_000) }), context);

    expect(asA.statusCode).toBe(200);
    expect(asB.statusCode).toBe(404);
    expect(asB).toEqual(unknown); // same status, headers and body: existence is not leaked
    expect(asB.body).not.toContain("secret");
  });

  it("user B does not see user A's request in the list", async () => {
    await createAs("user-a", "A's secret subject");
    const requestOfB = await createAs("user-b", "B's subject");

    const listOfB = await list(listRequestsEvent({ sub: "user-b" }), context);
    const listOfC = await list(listRequestsEvent({ sub: "user-c" }), context);

    const idsOfB = (json(listOfB) as { items: { id: string }[] }).items.map((item) => item.id);
    expect(idsOfB).toEqual([requestOfB.id]);
    expect(listOfB.body).not.toContain("secret");
    expect(json(listOfC)).toEqual({ items: [] });
  });

  it("user A still sees exactly their own requests", async () => {
    const first = await createAs("user-a", "first");
    await createAs("user-b", "of B");
    const second = await createAs("user-a", "second");

    const listOfA = await list(listRequestsEvent({ sub: "user-a" }), context);

    const ids = (json(listOfA) as { items: { id: string }[] }).items.map((item) => item.id);
    expect(ids.sort()).toEqual([first.id, second.id].sort());
  });

  it("an owner sent in the body cannot put a request into another user's partition", async () => {
    const body = JSON.stringify({
      partner: "Acme",
      subject: "S",
      body: "B",
      owner: "user-a",
      pk: "USER#user-a",
    });

    const response = await create(createRequestEvent({ sub: "user-b", body }), context);

    expect(response.statusCode).toBe(400);
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("every DynamoDB call carries the caller's partition key, whatever the input", async () => {
    const requestOfA = await createAs("user-a", "A's subject");
    ddb.resetHistory();

    const bodyOfB = JSON.stringify({ partner: "p", subject: "s", body: "b" });
    await create(createRequestEvent({ sub: "user-b", body: bodyOfB }), context);
    await get(getRequestEvent({ sub: "user-b", id: requestOfA.id }), context);
    await list(listRequestsEvent({ sub: "user-b" }), context);

    // The DocumentClient types these inputs loosely (`any`), so say what we expect to find.
    const partitionsUsed = [
      ...ddb.commandCalls(PutCommand).map((call) => (call.args[0].input.Item as { pk: string }).pk),
      ...ddb.commandCalls(GetCommand).map((call) => (call.args[0].input.Key as { pk: string }).pk),
      ...ddb
        .commandCalls(QueryCommand)
        .map((call) => (call.args[0].input.ExpressionAttributeValues as { ":pk": string })[":pk"]),
    ];
    expect(partitionsUsed).toEqual(["USER#user-b", "USER#user-b", "USER#user-b"]);
  });
});
