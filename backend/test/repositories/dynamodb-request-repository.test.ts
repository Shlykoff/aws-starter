import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { PartnerRequest } from "../../src/domain/request";
import { DynamoRequestRepository } from "../../src/repositories/dynamodb-request-repository";

// aws-sdk-client-mock replaces `send` on the DocumentClient, so nothing leaves the process
// and no credentials are needed. These tests pin down the exact commands, because a wrong
// key or a missing ScanIndexForward would only show up against a real table.
const ddb = mockClient(DynamoDBDocumentClient);
const repository = new DynamoRequestRepository(
  DynamoDBDocumentClient.from(new DynamoDBClient({})),
  "demo-dev-requests",
);

afterEach(() => {
  ddb.reset();
});
afterAll(() => {
  ddb.restore();
});

const ID = "01J8Z3K5W0ABCDEFGHJKMNPQRS";
const request: PartnerRequest = {
  id: ID,
  partner: "Acme",
  subject: "Order 42",
  body: "Please ship.",
  status: "created",
  createdAt: "2026-09-20T12:00:00.000Z",
};

describe("DynamoRequestRepository.create", () => {
  it("puts one item keyed USER#<owner> / REQ#<id>, and refuses to overwrite an existing key", async () => {
    ddb.on(PutCommand).resolves({});

    await repository.create("user-a", request);

    const calls = ddb.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({
      TableName: "demo-dev-requests",
      Item: {
        pk: "USER#user-a",
        sk: `REQ#${ID}`,
        id: ID,
        partner: "Acme",
        subject: "Order 42",
        body: "Please ship.",
        status: "created",
        createdAt: "2026-09-20T12:00:00.000Z",
      },
      ConditionExpression: "attribute_not_exists(pk)",
    });
  });

  it("stores the traceparent in the same item when there is one, and no attribute when there is none", async () => {
    ddb.on(PutCommand).resolves({});
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    await repository.create("user-a", request, traceparent);
    await repository.create("user-a", request);

    const [withTrace, withoutTrace] = ddb.commandCalls(PutCommand).map((call) => call.args[0].input.Item);
    expect(withTrace).toMatchObject({ id: ID, traceparent });
    expect(withoutTrace).not.toHaveProperty("traceparent");
  });

  it("lets a failed conditional put reach the caller", async () => {
    ddb.on(PutCommand).rejects(
      new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} }),
    );

    await expect(repository.create("user-a", request)).rejects.toBeInstanceOf(
      ConditionalCheckFailedException,
    );
  });

  it("lets other DynamoDB failures reach the caller", async () => {
    ddb.on(PutCommand).rejects(new Error("throttled"));

    await expect(repository.create("user-a", request)).rejects.toThrow("throttled");
  });
});

describe("DynamoRequestRepository.listByOwner", () => {
  it("queries the owner's partition newest first, with the given limit", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });

    await repository.listByOwner("user-a", 50);

    const calls = ddb.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({
      TableName: "demo-dev-requests",
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "USER#user-a" },
      ScanIndexForward: false,
      Limit: 50,
    });
  });

  it("maps items to the API model and keeps DynamoDB's order", async () => {
    const newer = { ...request, id: "01J8Z3K5W0ABCDEFGHJKMNPQRT", subject: "Newer" };
    ddb.on(QueryCommand).resolves({
      Items: [
        { pk: "USER#user-a", sk: `REQ#${newer.id}`, ...newer },
        { pk: "USER#user-a", sk: `REQ#${request.id}`, ...request },
      ],
    });

    const result = await repository.listByOwner("user-a", 50);

    expect(result).toEqual([newer, request]);
  });

  it("does not leak the key attributes (and with them the owner) into the result", async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ pk: "USER#user-a", sk: `REQ#${ID}`, ...request }] });

    const [first] = await repository.listByOwner("user-a", 50);

    expect(first).not.toHaveProperty("pk");
    expect(first).not.toHaveProperty("sk");
    expect(JSON.stringify(first)).not.toContain("user-a");
  });

  it("does not return the trace of a request: `traceparent` is for the pipeline, not for the API", async () => {
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    ddb.on(QueryCommand).resolves({ Items: [{ pk: "USER#user-a", sk: `REQ#${ID}`, ...request, traceparent }] });
    ddb.on(GetCommand).resolves({ Item: { pk: "USER#user-a", sk: `REQ#${ID}`, ...request, traceparent } });

    const [listed] = await repository.listByOwner("user-a", 50);
    const found = await repository.findById("user-a", ID);

    expect(listed).toEqual(request);
    expect(found).toEqual(request);
    expect(JSON.stringify([listed, found])).not.toContain("traceparent");
  });

  it("returns an empty list when DynamoDB returns no Items", async () => {
    ddb.on(QueryCommand).resolves({});

    expect(await repository.listByOwner("user-a", 50)).toEqual([]);
  });

  it("lets DynamoDB failures reach the caller", async () => {
    ddb.on(QueryCommand).rejects(new Error("ProvisionedThroughputExceededException"));

    await expect(repository.listByOwner("user-a", 50)).rejects.toThrow(
      "ProvisionedThroughputExceededException",
    );
  });
});

describe("DynamoRequestRepository.findById", () => {
  it("gets the item by the owner's pk and REQ#<id>", async () => {
    ddb.on(GetCommand).resolves({});

    await repository.findById("user-a", ID);

    const calls = ddb.commandCalls(GetCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({
      TableName: "demo-dev-requests",
      Key: { pk: "USER#user-a", sk: `REQ#${ID}` },
    });
  });

  it("maps the stored item to the API model", async () => {
    ddb.on(GetCommand).resolves({ Item: { pk: "USER#user-a", sk: `REQ#${ID}`, ...request } });

    expect(await repository.findById("user-a", ID)).toEqual(request);
  });

  it("returns undefined when there is no such item", async () => {
    ddb.on(GetCommand).resolves({});

    expect(await repository.findById("user-b", ID)).toBeUndefined();
  });

  it("lets DynamoDB failures reach the caller", async () => {
    ddb.on(GetCommand).rejects(new Error("network down"));

    await expect(repository.findById("user-a", ID)).rejects.toThrow("network down");
  });
});

describe("the client's decision in the API model", () => {
  const stored = {
    decision: "Declined",
    reason: "Out of stock",
    at: "2026-09-21T10:15:32.000Z",
    receivedAt: "2026-09-21T10:15:40.000Z",
    eventId: "3f0c6b1e-5a4d-4e7b-9c1a-2d6e8f0a1b3c",
  };
  const item = { pk: "USER#user-a", sk: `REQ#${ID}`, ...request, decisionAtMs: 1789985732000, clientDecision: stored };
  const apiDecision = { decision: "Declined", reason: "Out of stock", at: stored.at, receivedAt: stored.receivedAt };

  it("is returned by findById, without the event id and without decisionAtMs", async () => {
    ddb.on(GetCommand).resolves({ Item: item });

    const result = await repository.findById("user-a", ID);

    expect(result).toStrictEqual({ ...request, clientDecision: apiDecision });
  });

  it("is returned by listByOwner, without the event id and without decisionAtMs", async () => {
    ddb.on(QueryCommand).resolves({ Items: [item, { pk: "USER#user-a", sk: "REQ#other", ...request, id: "other" }] });

    const result = await repository.listByOwner("user-a", 50);

    expect(result[0]).toStrictEqual({ ...request, clientDecision: apiDecision });
    expect(JSON.stringify(result)).not.toContain(stored.eventId);
    expect(JSON.stringify(result)).not.toContain("decisionAtMs");
    expect(result[1]).not.toHaveProperty("clientDecision"); // absent, not undefined
  });

  it("has no reason when the stored decision has none", async () => {
    const withoutReason = { decision: stored.decision, at: stored.at, receivedAt: stored.receivedAt, eventId: stored.eventId };
    ddb.on(GetCommand).resolves({ Item: { ...item, clientDecision: withoutReason } });

    const result = await repository.findById("user-a", ID);

    expect(result?.clientDecision).toStrictEqual({ decision: "Declined", at: stored.at, receivedAt: stored.receivedAt });
  });
});

describe("DynamoRequestRepository.retry", () => {
  const conditionFailed = (item?: Record<string, unknown>) =>
    new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {}, Item: item as never });

  it("makes one conditional update: created and one more send, only if the item is failed", async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { pk: "USER#user-a", sk: `REQ#${ID}`, ...request, retryCount: 1 } });

    await repository.retry("user-a", ID);

    const calls = ddb.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({
      TableName: "demo-dev-requests",
      Key: { pk: "USER#user-a", sk: `REQ#${ID}` },
      UpdateExpression: "SET #status = :created ADD retryCount :one",
      ConditionExpression: "attribute_exists(pk) AND #status IN (:from0)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":created": "created", ":from0": "failed", ":one": 1 },
      ReturnValues: "ALL_NEW",
      ReturnValuesOnConditionCheckFailure: "ALL_OLD",
    });
  });

  it("replaces the stored trace in the same update when there is a new one", async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { pk: "USER#user-a", sk: `REQ#${ID}`, ...request, retryCount: 1 } });
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    await repository.retry("user-a", ID, traceparent);

    // One update: the status, the count and the trace change together, under the same condition.
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(1);
    expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
      UpdateExpression: "SET #status = :created, traceparent = :traceparent ADD retryCount :one",
      ConditionExpression: "attribute_exists(pk) AND #status IN (:from0)",
      ExpressionAttributeValues: { ":created": "created", ":from0": "failed", ":one": 1, ":traceparent": traceparent },
    });
  });

  it("does not return the trace either, when the item that came back has one", async () => {
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    ddb.on(UpdateCommand).resolves({ Attributes: { pk: "USER#user-a", sk: `REQ#${ID}`, ...request, retryCount: 1, traceparent } });

    const outcome = await repository.retry("user-a", ID, traceparent);

    expect(JSON.stringify(outcome)).not.toContain("traceparent");
  });

  it("returns the item after the update as the API model, without keys or the retry count, and the new count next to it", async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { pk: "USER#user-a", sk: `REQ#${ID}`, ...request, retryCount: 2 } });

    const outcome = await repository.retry("user-a", ID);

    expect(outcome).toEqual({ kind: "restarted", request, retryCount: 2 });
    expect(JSON.stringify(outcome.kind === "restarted" && outcome.request)).not.toContain("retryCount"); // never in the API model
    expect(JSON.stringify(outcome)).not.toContain("user-a");
  });

  it("says not_failed, with the status of the old item, when the condition fails and an item came back", async () => {
    // The exception carries the item in DynamoDB's typed format.
    ddb.on(UpdateCommand).rejects(conditionFailed({ pk: { S: "USER#user-a" }, sk: { S: `REQ#${ID}` }, status: { S: "sent" } }));

    expect(await repository.retry("user-a", ID)).toEqual({ kind: "not_failed", status: "sent" });
  });

  it("says not_found when the condition fails and no item came back", async () => {
    ddb.on(UpdateCommand).rejects(conditionFailed());

    expect(await repository.retry("user-a", ID)).toEqual({ kind: "not_found" });
  });

  it("lets other DynamoDB failures reach the caller", async () => {
    ddb.on(UpdateCommand).rejects(new Error("throttled"));

    await expect(repository.retry("user-a", ID)).rejects.toThrow("throttled");
  });
});
