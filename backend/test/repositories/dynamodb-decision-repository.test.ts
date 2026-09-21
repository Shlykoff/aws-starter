import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { StoredClientDecision } from "../../src/domain/client-decision";
import { DynamoDecisionRepository } from "../../src/repositories/dynamodb-decision-repository";

// aws-sdk-client-mock replaces `send` on the DocumentClient, so nothing leaves the process.
// These tests pin down the exact commands (the index, the keys, the condition), because a
// wrong one would only show up against a real table. What the condition DECIDES is tested in
// test/handlers/receive-webhook.test.ts, against a table that evaluates it.
const ddb = mockClient(DynamoDBDocumentClient);
const repository = new DynamoDecisionRepository(
  DynamoDBDocumentClient.from(new DynamoDBClient({})),
  "demo-dev-requests",
);

afterEach(() => {
  ddb.reset();
});
afterAll(() => {
  ddb.restore();
});

const ID = "01M30JDSMHY8CRX59V35WV731S";
const AT_MS = Date.UTC(2026, 8, 21, 10, 15, 32);
const decision: StoredClientDecision = {
  decision: "Declined",
  reason: "Out of stock",
  at: "2026-09-21T10:15:32.000Z",
  receivedAt: "2026-09-21T10:15:40.000Z",
  eventId: "3f0c6b1e-5a4d-4e7b-9c1a-2d6e8f0a1b3c",
};
const record = (value = decision) => repository.recordDecision(ID, value, AT_MS);

// What DynamoDB puts into the exception when it was asked for ALL_OLD: the old item, in its typed format.
const conditionFailed = (oldItem?: Record<string, unknown>) =>
  new ConditionalCheckFailedException({
    message: "The conditional request failed",
    $metadata: {},
    ...(oldItem !== undefined && { Item: marshall(oldItem) }),
  });
const found = () => ddb.on(QueryCommand).resolves({ Items: [{ pk: "USER#user-a", sk: `REQ#${ID}` }] });

describe("DynamoDecisionRepository.recordDecision", () => {
  it("finds the owner through the index by the request id alone, one item at most", async () => {
    found();
    ddb.on(UpdateCommand).resolves({});

    await record();

    expect(ddb.commandCalls(QueryCommand).map((call) => call.args[0].input)).toEqual([
      {
        TableName: "demo-dev-requests",
        IndexName: "by-request-id",
        KeyConditionExpression: "sk = :sk",
        ExpressionAttributeValues: { ":sk": `REQ#${ID}` },
        Limit: 1,
      },
    ]);
  });

  it("then updates that one item with one conditional UpdateItem", async () => {
    found();
    ddb.on(UpdateCommand).resolves({});

    expect(await record()).toBe("applied");

    expect(ddb.commandCalls(UpdateCommand).map((call) => call.args[0].input)).toEqual([
      {
        TableName: "demo-dev-requests",
        Key: { pk: "USER#user-a", sk: `REQ#${ID}` },
        UpdateExpression: "SET clientDecision = :decision, decisionAtMs = :ms",
        // attribute_exists(pk) keeps UpdateItem from creating an item; `<` (not `<=`) means an
        // event at the same moment is not newer; the event id check means the same event never
        // replaces itself.
        ConditionExpression:
          "attribute_exists(pk) AND (attribute_not_exists(decisionAtMs) OR " +
          "(decisionAtMs < :ms AND clientDecision.eventId <> :eventId))",
        ExpressionAttributeValues: { ":decision": decision, ":ms": AT_MS, ":eventId": decision.eventId },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      },
    ]);
  });

  it("writes values that the real DynamoDB client can marshal, with and without a reason", async () => {
    found();
    ddb.on(UpdateCommand).resolves({});
    const withoutReason: StoredClientDecision = { ...decision, reason: undefined };
    delete withoutReason.reason;

    await record();
    await record(withoutReason);

    // The document client refuses `undefined` inside a map: marshall does the same.
    for (const call of ddb.commandCalls(UpdateCommand)) {
      expect(() => {
        marshall(call.args[0].input.ExpressionAttributeValues);
      }).not.toThrow();
    }
    const [, second] = ddb.commandCalls(UpdateCommand);
    expect(second?.args[0].input.ExpressionAttributeValues?.[":decision"]).not.toHaveProperty("reason");
  });

  it("answers unknown_request, without an update, when the index has no such request", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });

    expect(await record()).toBe("unknown_request");
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("answers unknown_request when the query returns no Items at all", async () => {
    ddb.on(QueryCommand).resolves({});

    expect(await record()).toBe("unknown_request");
  });

  describe("when the condition fails", () => {
    it("answers duplicate when the stored decision is from the same event", async () => {
      found();
      ddb.on(UpdateCommand).rejects(conditionFailed({ pk: "USER#user-a", decisionAtMs: AT_MS, clientDecision: decision }));

      expect(await record()).toBe("duplicate");
    });

    it("answers ignored when the stored decision is from another event (an older one, or one at the same moment)", async () => {
      found();
      ddb.on(UpdateCommand).rejects(
        conditionFailed({
          pk: "USER#user-a",
          decisionAtMs: AT_MS + 1000,
          clientDecision: { ...decision, eventId: "aaaaaaaa-5a4d-4e7b-9c1a-2d6e8f0a1b3c" },
        }),
      );

      expect(await record()).toBe("ignored");
    });

    it("answers unknown_request when no old item came back (the request is gone: the index was stale)", async () => {
      found();
      ddb.on(UpdateCommand).rejects(conditionFailed());

      expect(await record()).toBe("unknown_request");
    });

    it("answers ignored when the old item has no readable decision (it cannot be this event)", async () => {
      found();
      ddb.on(UpdateCommand).rejects(conditionFailed({ pk: "USER#user-a", decisionAtMs: AT_MS + 1 }));

      expect(await record()).toBe("ignored");
    });
  });

  describe("real failures reach the caller", () => {
    it("of the query", async () => {
      ddb.on(QueryCommand).rejects(new Error("throttled"));

      await expect(record()).rejects.toThrow("throttled");
      expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    it("of the update", async () => {
      found();
      ddb.on(UpdateCommand).rejects(new Error("ProvisionedThroughputExceededException"));

      await expect(record()).rejects.toThrow("ProvisionedThroughputExceededException");
    });
  });
});
