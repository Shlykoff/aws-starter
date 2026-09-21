import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { AwsClientStub } from "aws-sdk-client-mock";
import { applyUpdate, evaluateCondition } from "./dynamo-condition";

// A tiny in-memory stand-in for the DynamoDB table, plugged in behind
// aws-sdk-client-mock. It understands exactly the three calls the repository makes, and
// it honours the same rules DynamoDB does: items are addressed by (pk, sk), a Query only
// sees one partition, results are sorted by the sort key, `ScanIndexForward=false`
// reverses them, and `Limit` cuts them. For the delivery pipeline it also understands the
// one conditional UpdateItem the repository makes (see below).
//
// Because it works from the real keys, a bug that used the wrong key (for example another
// user's pk) would show up as a wrong result in the handler tests.
//
// For the webhook it also understands the index `by-request-id` (partition key `sk`, KEYS_ONLY:
// the answer holds pk and sk and nothing else) and a conditional UpdateItem that it EVALUATES
// (see dynamo-condition.ts). Like DynamoDB, that update creates the item when the condition
// lets it through and the item is missing, a failed condition hands the old item back, in
// DynamoDB's typed format, when the request asks for it (ReturnValuesOnConditionCheckFailure),
// and a successful one hands the new item back as a plain object for ReturnValues ALL_NEW
// (the retry of a failed request, which also counts with `ADD retryCount :one`) and the old one
// for ALL_OLD (the decision of the webhook, which reads the `traceparent` of the request).

export interface StoredItem {
  pk: string;
  sk: string;
  [attribute: string]: unknown;
}

export interface FakeTable {
  /** Every item currently stored. */
  items(): StoredItem[];
  /** Puts an item straight into the table, bypassing the code under test. */
  seed(item: StoredItem): void;
}

export function stubTable(mock: AwsClientStub<DynamoDBDocumentClient>): FakeTable {
  const table = new Map<string, StoredItem>();
  const keyOf = (pk: string, sk: string): string => `${pk}\u0000${sk}`;

  mock.on(PutCommand).callsFake((input: { Item: StoredItem; ConditionExpression?: string }) => {
    const { Item: item, ConditionExpression: condition } = input;
    if (condition !== undefined && condition !== "attribute_not_exists(pk)") {
      throw new Error(`fake table: unsupported ConditionExpression "${condition}"`);
    }
    if (condition !== undefined && table.has(keyOf(item.pk, item.sk))) {
      throw new ConditionalCheckFailedException({
        message: "The conditional request failed",
        $metadata: {},
      });
    }
    table.set(keyOf(item.pk, item.sk), structuredClone(item));
    return {};
  });

  mock.on(GetCommand).callsFake((input: { Key: { pk: string; sk: string } }) => {
    const item = table.get(keyOf(input.Key.pk, input.Key.sk));
    return item === undefined ? {} : { Item: structuredClone(item) };
  });

  // The status update of the delivery pipeline: `SET #status = :to` guarded by
  // `#status IN (:from0, ...)`. Like DynamoDB, a missing item fails the condition (it has no
  // status) and is not created, and a failed condition writes nothing.
  // Every other update goes to the evaluator (the webhook's decision).
  mock.on(UpdateCommand).callsFake(
    (input: {
      Key: { pk: string; sk: string };
      UpdateExpression?: string;
      ConditionExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
      ExpressionAttributeValues: Record<string, unknown>;
      ReturnValues?: string;
      ReturnValuesOnConditionCheckFailure?: string;
    }) => {
      if (input.UpdateExpression !== "SET #status = :to") return evaluatedUpdate(input);

      if (input.ExpressionAttributeNames?.["#status"] !== "status") {
        throw new Error("fake table: #status must be mapped to the attribute `status`");
      }
      const condition = /^#status IN \((.+)\)$/.exec(input.ConditionExpression ?? "");
      if (condition?.[1] === undefined) {
        throw new Error(`fake table: unsupported ConditionExpression "${input.ConditionExpression}"`);
      }
      const allowed = condition[1]
        .split(",")
        .map((placeholder) => input.ExpressionAttributeValues[placeholder.trim()]);

      const item = table.get(keyOf(input.Key.pk, input.Key.sk));
      if (item === undefined || !allowed.includes(item.status)) {
        throw new ConditionalCheckFailedException({
          message: "The conditional request failed",
          $metadata: {},
        });
      }
      item.status = input.ExpressionAttributeValues[":to"];
      return {};
    },
  );

  function evaluatedUpdate(input: {
    Key: { pk: string; sk: string };
    UpdateExpression?: string;
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues: Record<string, unknown>;
    ReturnValues?: string;
    ReturnValuesOnConditionCheckFailure?: string;
  }): Record<string, unknown> {
    const stored = table.get(keyOf(input.Key.pk, input.Key.sk));
    const context = {
      item: stored,
      values: input.ExpressionAttributeValues,
      names: input.ExpressionAttributeNames ?? {},
    };
    if (input.ConditionExpression !== undefined && !evaluateCondition(input.ConditionExpression, context)) {
      throw new ConditionalCheckFailedException({
        message: "The conditional request failed",
        $metadata: {},
        // DynamoDB returns the old item only when it is asked to, and in its typed format.
        ...(input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" &&
          stored !== undefined && { Item: marshall(stored, { removeUndefinedValues: true }) }),
      });
    }
    // UpdateItem CREATES an item that does not exist: only a condition can prevent it.
    const item = stored ?? { pk: input.Key.pk, sk: input.Key.sk };
    const before = stored === undefined ? undefined : structuredClone(stored);
    applyUpdate(item, input.UpdateExpression ?? "", context);
    table.set(keyOf(input.Key.pk, input.Key.sk), item);
    // The document client hands the item back as a plain object when asked: as it is now
    // (ALL_NEW), or as it was before the update (ALL_OLD, nothing for an item that was created).
    if (input.ReturnValues === "ALL_NEW") return { Attributes: structuredClone(item) };
    if (input.ReturnValues === "ALL_OLD" && before !== undefined) return { Attributes: before };
    return {};
  }

  mock.on(QueryCommand).callsFake(
    (input: {
      IndexName?: string;
      KeyConditionExpression?: string;
      ExpressionAttributeValues?: Record<string, string>;
      ScanIndexForward?: boolean;
      Limit?: number;
    }) => {
      if (input.IndexName === "by-request-id") {
        if (input.KeyConditionExpression !== "sk = :sk") {
          throw new Error(`fake table: unsupported KeyConditionExpression "${input.KeyConditionExpression}"`);
        }
        const sk = input.ExpressionAttributeValues?.[":sk"];
        const found = [...table.values()].filter((item) => item.sk === sk);
        // KEYS_ONLY: the index holds the keys and nothing else.
        const keys = found.map(({ pk, sk: key }) => ({ pk, sk: key }));
        return { Items: input.Limit === undefined ? keys : keys.slice(0, input.Limit) };
      }
      if (input.IndexName !== undefined) throw new Error(`fake table: unknown index "${input.IndexName}"`);
      if (input.KeyConditionExpression !== "pk = :pk") {
        throw new Error(`fake table: unsupported KeyConditionExpression "${input.KeyConditionExpression}"`);
      }
      const pk = input.ExpressionAttributeValues?.[":pk"];
      const sorted = [...table.values()]
        .filter((item) => item.pk === pk)
        .sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
      // DynamoDB's default is ascending; only an explicit `false` reverses.
      if (input.ScanIndexForward === false) sorted.reverse();
      const page = input.Limit === undefined ? sorted : sorted.slice(0, input.Limit);
      return { Items: structuredClone(page) };
    },
  );

  return {
    items: () => [...table.values()],
    seed: (item) => {
      table.set(keyOf(item.pk, item.sk), structuredClone(item));
    },
  };
}
