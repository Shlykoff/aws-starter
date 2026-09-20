import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { AwsClientStub } from "aws-sdk-client-mock";

// A tiny in-memory stand-in for the DynamoDB table, plugged in behind
// aws-sdk-client-mock. It understands exactly the three calls the repository makes, and
// it honours the same rules DynamoDB does: items are addressed by (pk, sk), a Query only
// sees one partition, results are sorted by the sort key, `ScanIndexForward=false`
// reverses them, and `Limit` cuts them. For the delivery pipeline it also understands the
// one conditional UpdateItem the repository makes (see below).
//
// Because it works from the real keys, a bug that used the wrong key (for example another
// user's pk) would show up as a wrong result in the handler tests.

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
  mock.on(UpdateCommand).callsFake(
    (input: {
      Key: { pk: string; sk: string };
      UpdateExpression?: string;
      ConditionExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
      ExpressionAttributeValues: Record<string, unknown>;
    }) => {
      if (input.UpdateExpression !== "SET #status = :to") {
        throw new Error(`fake table: unsupported UpdateExpression "${input.UpdateExpression}"`);
      }
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

  mock.on(QueryCommand).callsFake(
    (input: {
      KeyConditionExpression?: string;
      ExpressionAttributeValues?: Record<string, string>;
      ScanIndexForward?: boolean;
      Limit?: number;
    }) => {
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
