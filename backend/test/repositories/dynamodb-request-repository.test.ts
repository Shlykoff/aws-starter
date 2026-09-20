import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
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
