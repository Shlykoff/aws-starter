import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { StoredClientDecision } from "../domain/client-decision";
import { requestKey } from "../domain/request-keys";
import type { DecisionRepository, RecordOutcome, RecordResult } from "./decision-repository";

// The same table and keys as DynamoRequestRepository (pk = USER#<sub>, sk = REQ#<ULID>; see
// the comment above that class). Access patterns of the webhook:
//
//   6. Find a request by its id alone      -> Query on the index `by-request-id`
//                                              (partition key sk, KEYS_ONLY: pk and sk)
//   7. Store the client's decision         -> UpdateItem (pk, sk), conditional
//
// Why an index: the event names the request only by id, and the table's key starts with the
// owner, which the webhook does not know (and must not be told: it has no user). `sk` is
// unique in the whole table because ULIDs are, so the index answers with at most one item.
// A GSI is eventually consistent; that is fine, because the request was created long before
// the client can act, and an id that is not in the index yet is answered 404, which the
// recipient does not retry (contracts/webhook-api.md).
//
// New attributes of the item (see docs/api.md, "Storage"):
//   clientDecision  map: decision, reason?, at, receivedAt, eventId
//   decisionAtMs    number: `at` as epoch milliseconds. It is what is compared, because ISO
//                   strings with different offsets do not sort by time.
//
// The update also reads one attribute, `traceparent` (the trace of the request, written by
// DynamoRequestRepository), from the old item that DynamoDB hands back with the answer: no
// extra read. The webhook uses it to record its span in that trace.
//
// The update touches only these two attributes, so it never interferes with the status
// changes of the delivery pipeline (DynamoDeliveryRepository), and the other way round.
// It is a MODIFY record in the stream, and the enqueuer's mapping reacts only to INSERT and to
// a request sent again (status `created` with a `retryCount`), so storing a decision never
// queues the request again. The one exception is a decision that arrives while a request that
// was sent again is still `created`: the enqueuer sends its message a second time, and the
// queue drops it (same deduplication id).

const INDEX_NAME = "by-request-id";

export class DynamoDecisionRepository implements DecisionRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async recordDecision(
    requestId: string,
    decision: StoredClientDecision,
    occurredAtMs: number,
  ): Promise<RecordResult> {
    const pk = await this.findOwnerKey(requestId);
    if (pk === undefined) return { outcome: "unknown_request" };

    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk, sk: requestKey(requestId) },
          UpdateExpression: "SET clientDecision = :decision, decisionAtMs = :ms",
          // One atomic check-and-write, so two events that arrive at the same moment cannot
          // both win: the later OccurredAt is stored whatever the order of arrival.
          //  - attribute_exists(pk): UpdateItem CREATES the item when it does not exist. This
          //    guard keeps the webhook from inventing a request that is not there.
          //  - no decision yet, or the stored one is strictly older AND belongs to another event.
          //    An equal time is not newer: the same event again, or another event at the same
          //    moment, changes nothing. The same EventId never replaces itself either, whatever
          //    time it carries (contracts/webhook-api.md: "same EventId: changes nothing").
          ConditionExpression:
            "attribute_exists(pk) AND (attribute_not_exists(decisionAtMs) OR " +
            "(decisionAtMs < :ms AND clientDecision.eventId <> :eventId))",
          ExpressionAttributeValues: {
            ":decision": decision,
            ":ms": occurredAtMs,
            ":eventId": decision.eventId,
          },
          // When the condition fails, DynamoDB hands back the item as it is, so that we can
          // tell "same event" from "older event" from "no such item" without a second read
          // (which could see a different item than the one that failed the condition).
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          // When it succeeds, the item as it was before: only its `traceparent` is used (the
          // rest holds the request text and goes nowhere). It costs no read and no permission.
          ReturnValues: "ALL_OLD",
        }),
      );
      return { outcome: "applied", ...storedTrace(result.Attributes) };
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return classify(error, decision.eventId);
      throw error;
    }
  }

  // The index holds only the keys (KEYS_ONLY), which is all that is needed. Limit 1: the id is unique.
  private async findOwnerKey(requestId: string): Promise<string | undefined> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: INDEX_NAME,
        KeyConditionExpression: "sk = :sk",
        ExpressionAttributeValues: { ":sk": requestKey(requestId) },
        Limit: 1,
      }),
    );
    const pk: unknown = result.Items?.[0]?.pk;
    return typeof pk === "string" ? pk : undefined;
  }
}

// The trace of an item, if it has one. A value that is not a string is not a trace.
function storedTrace(item: { traceparent?: unknown } | undefined): { traceparent?: string } {
  return typeof item?.traceparent === "string" ? { traceparent: item.traceparent } : {};
}

// Why did the condition fail?
function classify(error: ConditionalCheckFailedException, eventId: string): RecordResult {
  // No item came back: attribute_exists(pk) failed, the request is gone (the index was stale).
  if (error.Item === undefined) return { outcome: "unknown_request" };

  // The document client does not convert what is in an exception, so it is in DynamoDB's
  // typed format ({ S: "..." }) and is unmarshalled here.
  const stored = unmarshall(error.Item) as { clientDecision?: { eventId?: string }; traceparent?: unknown };
  // The same event again (a repeated delivery), or another event that is not newer.
  const outcome: RecordOutcome = stored.clientDecision?.eventId === eventId ? "duplicate" : "ignored";
  return { outcome, ...storedTrace(stored) };
}
