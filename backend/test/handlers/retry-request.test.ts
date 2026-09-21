import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { ulid } from "ulid";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../src/handlers/retry-request";
import { eventWithoutSub, lambdaContext, retryRequestEvent } from "../helpers/events";
import { stubTable } from "../helpers/fake-table";
import type { FakeTable } from "../helpers/fake-table";
import { captureLogs } from "../helpers/logs";

// The real handler, service, repository and container. Only DynamoDB is an in-memory table that
// really evaluates the ConditionExpression (see helpers/fake-table.ts), so what these tests see
// is what the condition of the code lets through, not a string that was compared.
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
const key = { pk: "USER#user-a", sk: `REQ#${ID}` };
const fields = {
  id: ID,
  partner: "Acme",
  subject: "Order 42",
  body: "Please ship.",
  createdAt: "2026-09-20T12:00:00.000Z",
};

const seed = (status: string, extra: Record<string, unknown> = {}) =>
  table.seed({ ...key, ...fields, status, ...extra });
const storedItem = () => table.items().find((item) => item.sk === key.sk);
const retry = (options: { sub?: string; id?: string } = { sub: "user-a", id: ID }) =>
  handler(retryRequestEvent(options), lambdaContext());
const json = (response: { body?: string }): unknown => JSON.parse(response.body ?? "null");
const notFound = { error: { code: "not_found", message: "Request not found" } };

describe("POST /requests/{id}/retry: a failed request", () => {
  it("answers 200 with the request in status created, without the owner, the keys or the retry count", async () => {
    seed("failed");

    const response = await retry();

    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual({ "content-type": "application/json" });
    expect(json(response)).toEqual({ ...fields, status: "created" });
    expect(response.body).not.toContain("user-a");
    expect(response.body).not.toContain("retryCount");
  });

  it("stores status created and counts the send: the change the stream shows to the enqueuer", async () => {
    seed("failed");

    await retry();

    expect(storedItem()).toMatchObject({ status: "created", retryCount: 1 });
  });

  it("changes the item with one conditional update on the token's sub and the id, and reads nothing else", async () => {
    seed("failed");

    await retry();

    expect(ddb.calls()).toHaveLength(1);
    expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input.Key).toEqual(key);
  });

  it("counts every send: retryCount is 1, then 2 after the request failed again", async () => {
    seed("failed");
    await retry();
    expect(storedItem()?.retryCount).toBe(1);

    // The pipeline delivers it again and fails again (the worker writes failed).
    table.seed({ ...key, ...fields, status: "failed", retryCount: 1 });
    const second = await retry();

    expect(second.statusCode).toBe(200);
    expect(storedItem()).toMatchObject({ status: "created", retryCount: 2 });
    expect(second.body).not.toContain("retryCount");
  });

  it("keeps the client's decision, and does not return its internals", async () => {
    seed("failed", {
      decisionAtMs: 1789985732000,
      clientDecision: {
        decision: "Declined",
        reason: "Out of stock",
        at: "2026-09-21T10:15:32.000Z",
        receivedAt: "2026-09-21T10:15:40.000Z",
        eventId: "3f0c6b1e-5a4d-4e7b-9c1a-2d6e8f0a1b3c",
      },
    });

    const response = await retry();

    expect(json(response)).toEqual({
      ...fields,
      status: "created",
      clientDecision: {
        decision: "Declined",
        reason: "Out of stock",
        at: "2026-09-21T10:15:32.000Z",
        receivedAt: "2026-09-21T10:15:40.000Z",
      },
    });
    expect(response.body).not.toContain("eventId");
    expect(response.body).not.toContain("decisionAtMs");
    expect(storedItem()).toMatchObject({ decisionAtMs: 1789985732000, clientDecision: { eventId: expect.any(String) as string } });
  });
});

describe("POST /requests/{id}/retry: a request that is not failed", () => {
  it.each(["created", "queued", "sent", "rejected"])(
    "answers 409 not_retryable for a %s request, names the status and changes nothing",
    async (status) => {
      seed(status);
      const before = structuredClone(storedItem());

      const response = await retry();

      expect(response.statusCode).toBe(409);
      expect(json(response)).toEqual({
        error: { code: "not_retryable", message: `Only a failed request can be sent again (it is ${status})` },
      });
      expect(storedItem()).toEqual(before); // no status change, no retryCount
    },
  );

  it("pressing twice is safe: the second press finds created and gets 409, the count stays 1", async () => {
    seed("failed");

    const first = await retry();
    const second = await retry();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(json(second)).toMatchObject({ error: { message: "Only a failed request can be sent again (it is created)" } });
    expect(storedItem()).toMatchObject({ status: "created", retryCount: 1 });
  });
});

describe("POST /requests/{id}/retry: 404", () => {
  it("answers 404 for an id that does not exist, and creates nothing", async () => {
    const response = await retry();

    expect(response.statusCode).toBe(404);
    expect(json(response)).toEqual(notFound);
    expect(table.items()).toEqual([]);
  });

  it("answers 404 for another user's failed request, exactly like an unknown id, and leaves it failed", async () => {
    seed("failed");

    const asOther = await retry({ sub: "user-b", id: ID });
    const unknown = await retry({ sub: "user-b", id: ulid(1_000) });

    expect(asOther.statusCode).toBe(404);
    expect(asOther).toEqual(unknown); // existence is not leaked
    expect(storedItem()).toMatchObject({ status: "failed" });
    expect(storedItem()).not.toHaveProperty("retryCount");
  });

  it("answers 404 for an id that is not a ULID, without touching the table", async () => {
    for (const id of ["nope", "../../etc", "x".repeat(3000)]) {
      const response = await retry({ sub: "user-a", id });

      expect(response.statusCode).toBe(404);
      expect(json(response)).toEqual(notFound);
    }
    expect(ddb.calls()).toHaveLength(0);
  });

  it("answers 404 if the path parameter is missing altogether", async () => {
    const response = await retry({ sub: "user-a" });

    expect(response.statusCode).toBe(404);
    expect(ddb.calls()).toHaveLength(0);
  });
});

describe("POST /requests/{id}/retry: failures", () => {
  it("fails with 500 when the token has no sub claim, without touching the table", async () => {
    const response = await handler(eventWithoutSub("POST /requests/{id}/retry", "no-authorizer"), lambdaContext());

    expect(response.statusCode).toBe(500);
    expect(json(response)).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
    expect(ddb.calls()).toHaveLength(0);
  });

  it("answers 500 without details when DynamoDB fails, and logs the cause", async () => {
    ddb.on(UpdateCommand).rejects(new Error("ServiceUnavailable"));

    const response = await retry();

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("ServiceUnavailable");
    expect(logs.entries()).toContainEqual(
      expect.objectContaining({ level: "error", errorMessage: "ServiceUnavailable" }),
    );
  });

  it("logs the route template and the status code, not the id", async () => {
    seed("sent");

    await retry();

    expect(logs.entries()).toEqual([
      expect.objectContaining({ route: "POST /requests/{id}/retry", statusCode: 409 }),
    ]);
    expect(logs.lines.join("\n")).not.toContain(ID);
  });
});
