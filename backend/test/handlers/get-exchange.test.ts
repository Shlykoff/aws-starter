import { GetObjectCommand, NoSuchKey, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { ulid } from "ulid";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Exchange } from "../../src/domain/exchange";
import { handler } from "../../src/handlers/get-exchange";
import { CORS_HEADERS, eventWithoutSub, getExchangeEvent, lambdaContext } from "../helpers/events";
import { stubTable } from "../helpers/fake-table";
import type { FakeTable } from "../helpers/fake-table";
import { captureLogs } from "../helpers/logs";

// The real handler, service, repository, S3 adapter and container. DynamoDB is an in-memory
// table with real key rules, S3 is a recorder.
const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);
let table: FakeTable;
let logs: ReturnType<typeof captureLogs>;

beforeEach(() => {
  ddb.reset();
  s3.reset();
  table = stubTable(ddb);
  logs = captureLogs();
});
afterAll(() => {
  ddb.restore();
  s3.restore();
});

const ID = ulid(Date.UTC(2026, 8, 20, 12, 0));
const request = { id: ID, partner: "Acme", subject: "Order 42", body: "Please ship.", status: "sent", createdAt: "2026-09-20T12:00:00.000Z" };
const exchange: Exchange = {
  attempt: 1,
  at: "2026-09-20T12:00:05.000Z",
  outcome: "delivered",
  request: { xml: "<Submission>Order 42</Submission>", valid: true, problems: [] },
  reply: { httpStatus: 200, xml: "<Reply/>", valid: true, status: "Accepted" },
};
const object = (text: string) => ({ Body: { transformToString: () => Promise.resolve(text) } as never });

const get = (options: { sub?: string; id?: string }) => handler(getExchangeEvent(options), lambdaContext());
const json = (response: { body?: string }): unknown => JSON.parse(response.body ?? "null");
const seedRequest = (owner = "user-a") => table.seed({ pk: `USER#${owner}`, sk: `REQ#${ID}`, ...request });

describe("GET /requests/{id}/exchange", () => {
  it("returns 200 and the exchange exactly as it was recorded", async () => {
    seedRequest();
    s3.on(GetObjectCommand).resolves(object(JSON.stringify(exchange)));

    const response = await get({ sub: "user-a", id: ID });

    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual(exchange);
  });

  it("tells clients and proxies not to keep a copy: the record holds the text of the request", async () => {
    seedRequest();
    s3.on(GetObjectCommand).resolves(object(JSON.stringify(exchange)));

    const response = await get({ sub: "user-a", id: ID });

    expect(response.headers).toEqual({ "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS });
  });

  it("checks the owner in the table with the token's sub, then reads the object of that request", async () => {
    seedRequest();
    s3.on(GetObjectCommand).resolves(object(JSON.stringify(exchange)));

    await get({ sub: "user-a", id: ID });

    expect(ddb.commandCalls(GetCommand).map((call) => call.args[0].input.Key)).toEqual([
      { pk: "USER#user-a", sk: `REQ#${ID}` },
    ]);
    expect(s3.commandCalls(GetObjectCommand).map((call) => call.args[0].input)).toEqual([
      { Bucket: "test-deliveries", Key: `exchanges/${ID}.json` },
    ]);
  });

  it("returns 404 for a request that does not exist, without touching S3", async () => {
    const response = await get({ sub: "user-a", id: ID });

    expect(response.statusCode).toBe(404);
    expect(json(response)).toEqual({ error: { code: "not_found", message: "Request not found" } });
    expect(s3.calls()).toHaveLength(0);
  });

  it("returns 404 for the request of another user, without touching S3", async () => {
    seedRequest("user-a");

    const response = await get({ sub: "user-b", id: ID });

    expect(response.statusCode).toBe(404);
    expect(json(response)).toEqual({ error: { code: "not_found", message: "Request not found" } });
    expect(s3.calls()).toHaveLength(0);
  });

  it("returns 404 for an id that is not a ULID, without reading the table or S3", async () => {
    for (const id of ["nope", "../../etc", "x".repeat(3000)]) {
      const response = await get({ sub: "user-a", id });

      expect(response.statusCode).toBe(404);
    }
    expect(ddb.calls()).toHaveLength(0);
    expect(s3.calls()).toHaveLength(0);
  });

  it("returns 404 if the path parameter is missing altogether", async () => {
    const response = await get({ sub: "user-a" });

    expect(response.statusCode).toBe(404);
    expect(ddb.calls()).toHaveLength(0);
  });

  it("returns 204 with no body for the caller's own request that has no exchange yet: not an error", async () => {
    seedRequest();
    s3.on(GetObjectCommand).rejects(new NoSuchKey({ message: "no such key", $metadata: {} }));

    const response = await get({ sub: "user-a", id: ID });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(response.headers).toEqual({ "cache-control": "no-store", ...CORS_HEADERS });
    // The owner was checked first, then S3 was asked once: 204 is not a shortcut around either.
    expect(ddb.commandCalls(GetCommand)).toHaveLength(1);
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(1);
  });

  it("logs the 204 as an ordinary answer: the route and the status, no error line", async () => {
    seedRequest();
    s3.on(GetObjectCommand).rejects(new NoSuchKey({ message: "no such key", $metadata: {} }));

    await get({ sub: "user-a", id: ID });

    expect(logs.entries()).toEqual([
      expect.objectContaining({ level: "info", route: "GET /requests/{id}/exchange", statusCode: 204 }),
    ]);
  });

  it("still returns 404, not 204, for the request of another user that has no exchange yet, without touching S3", async () => {
    seedRequest("user-a");
    s3.on(GetObjectCommand).rejects(new NoSuchKey({ message: "no such key", $metadata: {} }));

    const response = await get({ sub: "user-b", id: ID });

    expect(response.statusCode).toBe(404);
    expect(json(response)).toEqual({ error: { code: "not_found", message: "Request not found" } });
    expect(s3.calls()).toHaveLength(0);
  });

  it("returns 500, not 404, when S3 says AccessDenied: a missing permission is our problem", async () => {
    seedRequest();
    s3.on(GetObjectCommand).rejects(
      new S3ServiceException({ name: "AccessDenied", $fault: "client", $metadata: { httpStatusCode: 403 } }),
    );

    const response = await get({ sub: "user-a", id: ID });

    expect(response.statusCode).toBe(500);
    expect(json(response)).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
    expect(logs.entries()).toContainEqual(expect.objectContaining({ level: "error", errorName: "AccessDenied" }));
  });

  it("returns 500 without content when the stored object is broken, and logs no text from it", async () => {
    seedRequest();
    s3.on(GetObjectCommand).resolves(object(JSON.stringify({ ...exchange, outcome: "SECRET-value", request: { xml: "SECRET-xml" } })));

    const response = await get({ sub: "user-a", id: ID });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("SECRET");
    expect(logs.lines.join("\n")).not.toContain("SECRET");
    expect(logs.entries()).toContainEqual(
      expect.objectContaining({ level: "error", errorMessage: expect.stringContaining("does not match the expected shape") as string }),
    );
  });

  it("fails with 500 when the token has no sub claim, without reading anything", async () => {
    const response = await handler(eventWithoutSub("GET /requests/{id}/exchange", "no-authorizer"), lambdaContext());

    expect(response.statusCode).toBe(500);
    expect(response.headers).toMatchObject(CORS_HEADERS);
    expect(json(response)).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
    expect(ddb.calls()).toHaveLength(0);
    expect(s3.calls()).toHaveLength(0);
  });

  it("logs the route template, not the id, and nothing of the exchange", async () => {
    seedRequest();
    s3.on(GetObjectCommand).resolves(object(JSON.stringify(exchange)));

    await get({ sub: "user-a", id: ID });

    expect(logs.entries()).toEqual([
      expect.objectContaining({ route: "GET /requests/{id}/exchange", statusCode: 200 }),
    ]);
    expect(logs.lines.join("\n")).not.toContain("Order 42");
  });
});
