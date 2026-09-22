import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DynamoDeliveryRepository } from "../../src/repositories/dynamodb-delivery-repository";
import { stubTable } from "../helpers/fake-table";

const ddb = mockClient(DynamoDBDocumentClient);
const repository = new DynamoDeliveryRepository(
  DynamoDBDocumentClient.from(new DynamoDBClient({})),
  "demo-dev-requests",
);

afterEach(() => {
  ddb.reset();
});
afterAll(() => {
  ddb.restore();
});

const ID = "01J8Z3K5W0ABCDEFGHJKMNPQR1";
const KEY = { pk: "USER#user-a", sk: `REQ#${ID}` };
const stored = {
  ...KEY,
  id: ID,
  subject: "Order 42",
  body: "Please ship.",
  senderEmail: "sender@example.test",
  status: "queued",
  createdAt: "2026-09-21T09:00:00.000Z",
};

const conditionalFailure = () =>
  new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });

describe("DynamoDeliveryRepository.findForDelivery", () => {
  it("reads the item by the owner's pk and REQ#<id> with a consistent read", async () => {
    ddb.on(GetCommand).resolves({});

    await repository.findForDelivery("user-a", ID);

    const calls = ddb.commandCalls(GetCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({
      TableName: "demo-dev-requests",
      Key: KEY,
      ConsistentRead: true,
    });
  });

  it("returns the request with its status, without the key attributes", async () => {
    ddb.on(GetCommand).resolves({ Item: stored });

    const request = await repository.findForDelivery("user-a", ID);

    expect(request).toEqual({
      id: ID,
      subject: "Order 42",
      body: "Please ship.",
      senderEmail: "sender@example.test",
      status: "queued",
      createdAt: "2026-09-21T09:00:00.000Z",
    });
    expect(JSON.stringify(request)).not.toContain("user-a");
  });

  it("returns undefined when there is no such item", async () => {
    ddb.on(GetCommand).resolves({});

    expect(await repository.findForDelivery("user-a", ID)).toBeUndefined();
  });

  it("lets DynamoDB failures reach the caller", async () => {
    ddb.on(GetCommand).rejects(new Error("network down"));

    await expect(repository.findForDelivery("user-a", ID)).rejects.toThrow("network down");
  });
});

describe("the conditional status updates: commands", () => {
  it("markQueued sets queued only if the status is created", async () => {
    ddb.on(UpdateCommand).resolves({});

    await repository.markQueued("user-a", ID);

    expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input).toEqual({
      TableName: "demo-dev-requests",
      Key: KEY,
      UpdateExpression: "SET #status = :to",
      ConditionExpression: "#status IN (:from0)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":to": "queued", ":from0": "created" },
    });
  });

  it.each([
    ["markSent", "sent"],
    ["markRejected", "rejected"],
    ["markFailed", "failed"],
  ] as const)("%s sets %s only if the status is created or queued", async (method, target) => {
    ddb.on(UpdateCommand).resolves({});

    await repository[method]("user-a", ID);

    expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input).toEqual({
      TableName: "demo-dev-requests",
      Key: KEY,
      UpdateExpression: "SET #status = :to",
      ConditionExpression: "#status IN (:from0, :from1)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":to": target, ":from0": "created", ":from1": "queued" },
    });
  });

  it.each(["markQueued", "markSent", "markRejected", "markFailed"] as const)(
    "%s returns true when the update was applied",
    async (method) => {
      ddb.on(UpdateCommand).resolves({});

      expect(await repository[method]("user-a", ID)).toBe(true);
    },
  );

  it.each(["markQueued", "markSent", "markRejected", "markFailed"] as const)(
    "%s returns false, and does not throw, when the condition fails",
    async (method) => {
      ddb.on(UpdateCommand).rejects(conditionalFailure());

      expect(await repository[method]("user-a", ID)).toBe(false);
    },
  );

  it("lets every other failure reach the caller", async () => {
    ddb.on(UpdateCommand).rejects(new Error("ProvisionedThroughputExceededException"));

    await expect(repository.markSent("user-a", ID)).rejects.toThrow(
      "ProvisionedThroughputExceededException",
    );
  });
});

// The same methods against a table that evaluates the condition like DynamoDB does.
describe("the conditional status updates: effect on the table", () => {
  const item = (status: string) => ({ ...stored, status });

  it("moves created to queued", async () => {
    const table = stubTable(ddb);
    table.seed(item("created"));

    expect(await repository.markQueued("user-a", ID)).toBe(true);
    expect(table.items()[0]?.status).toBe("queued");
  });

  it.each(["queued", "sent", "rejected", "failed"])(
    "does not move %s to queued (a late enqueuer must not undo a result)",
    async (status) => {
      const table = stubTable(ddb);
      table.seed(item(status));

      expect(await repository.markQueued("user-a", ID)).toBe(false);
      expect(table.items()[0]?.status).toBe(status);
    },
  );

  it.each(["created", "queued"])("moves %s to sent, rejected and failed", async (from) => {
    for (const [method, target] of [
      ["markSent", "sent"],
      ["markRejected", "rejected"],
      ["markFailed", "failed"],
    ] as const) {
      const table = stubTable(ddb);
      table.seed(item(from));

      expect(await repository[method]("user-a", ID)).toBe(true);
      expect(table.items()[0]?.status).toBe(target);
    }
  });

  it.each(["sent", "rejected", "failed"])(
    "never changes the terminal status %s again",
    async (terminal) => {
      for (const method of ["markSent", "markRejected", "markFailed", "markQueued"] as const) {
        const table = stubTable(ddb);
        table.seed(item(terminal));

        expect(await repository[method]("user-a", ID)).toBe(false);
        expect(table.items()[0]?.status).toBe(terminal);
      }
    },
  );

  it("does not create an item that does not exist", async () => {
    const table = stubTable(ddb);

    expect(await repository.markSent("user-a", ID)).toBe(false);
    expect(table.items()).toEqual([]);
  });

  it("does not touch another owner's request with the same id", async () => {
    const table = stubTable(ddb);
    table.seed({ ...item("queued"), pk: "USER#user-b" });

    expect(await repository.markSent("user-a", ID)).toBe(false);
    expect(table.items()[0]?.status).toBe("queued");
  });
});
