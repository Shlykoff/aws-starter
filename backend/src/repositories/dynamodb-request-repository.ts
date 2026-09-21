import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { toClientDecision } from "../domain/client-decision";
import type { StoredClientDecision } from "../domain/client-decision";
import type { PartnerRequest, RequestStatus } from "../domain/request";
import { ownerKey, requestKey } from "../domain/request-keys";
import type { RequestRepository, RetryOutcome } from "./request-repository";

// DynamoDB table `<project>-<env>-requests` (created by Terraform, see docs/api.md).
//
// Access patterns, and the key design that serves them (no secondary index):
//
//   1. Create a request                 -> PutItem   (pk, sk)
//   2. List one user's requests,
//      newest first, at most 50         -> Query     pk = :pk, ScanIndexForward = false, Limit
//   3. Read one of the user's requests  -> GetItem   (pk, sk)
//   6. Send a failed request again      -> UpdateItem (pk, sk), conditional on status = failed
//      (numbers 4 and 5 belong to the delivery side, see dynamodb-delivery-repository.ts)
//
// Keys:
//   pk (partition key, S)  "USER#<sub>"   the owner: the `sub` claim of the Cognito token
//   sk (sort key, S)       "REQ#<ULID>"   a ULID sorts by creation time, so a descending
//                                         Query on one pk returns the newest request first
//
// Other attributes: id, partner, subject, body, status, createdAt (see RequestItem), retryCount
// once the request has been sent again, and once the client has acted clientDecision and
// decisionAtMs (written by the webhook, see dynamodb-decision-repository.ts, which also
// explains the index `by-request-id`).
//
// Why this is safe: `ownerId` always comes from the verified token, never from the client,
// and it is the whole partition key. A user therefore cannot even address another user's
// items; no filter or ownership check on the results is needed.
//
// One partition per user is fine here: traffic is spread across users. A hot partition
// would need a single user sending very heavy traffic.

/** An item as stored: the API model plus the two key attributes. */
interface RequestItem {
  pk: string;
  sk: string;
  id: string;
  partner: string;
  subject: string;
  body: string;
  status: RequestStatus;
  createdAt: string;
  // Only there once the request has been sent again. Counted here, never returned.
  retryCount?: number;
  // Only there once the client has acted. `decisionAtMs` (the number the webhook compares) is
  // stored too, but the API never needs it, so it is not part of this type.
  clientDecision?: StoredClientDecision;
}

// The reverse mapping. It copies fields one by one instead of returning the item, so `pk`
// and `sk` (which contain the owner) and `decisionAtMs` can never end up in an API response.
// `toClientDecision` does the same for the decision, and leaves out its `eventId`.
function toPartnerRequest(item: RequestItem): PartnerRequest {
  return {
    id: item.id,
    partner: item.partner,
    subject: item.subject,
    body: item.body,
    status: item.status,
    createdAt: item.createdAt,
    ...(item.clientDecision !== undefined && { clientDecision: toClientDecision(item.clientDecision) }),
  };
}

export class DynamoRequestRepository implements RequestRepository {
  constructor(
    // The DocumentClient reads and writes plain JS objects instead of DynamoDB's typed
    // attribute format ({ S: "..." }). It is created once, in the container.
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async create(ownerId: string, request: PartnerRequest): Promise<void> {
    const item: RequestItem = {
      pk: ownerKey(ownerId),
      sk: requestKey(request.id),
      id: request.id,
      partner: request.partner,
      subject: request.subject,
      body: request.body,
      status: request.status,
      createdAt: request.createdAt,
    };

    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
        // PutItem silently replaces an existing item with the same key. This condition
        // turns an (extremely unlikely) ULID collision into an error instead of
        // overwriting somebody's request.
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  }

  async listByOwner(ownerId: string, limit: number): Promise<PartnerRequest[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": ownerKey(ownerId) },
        ScanIndexForward: false, // descending sort key = newest ULID first
        Limit: limit,
      }),
    );

    // Only this repository writes to the table, so the stored shape is known.
    const items = (result.Items ?? []) as RequestItem[];
    return items.map(toPartnerRequest);
  }

  async findById(ownerId: string, id: string): Promise<PartnerRequest | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: ownerKey(ownerId), sk: requestKey(id) },
      }),
    );

    // No `Item` means no such key. For another user's id the key is simply different, so
    // it is "not found" too, which is what the API promises (404, not 403).
    const item = result.Item as RequestItem | undefined;
    return item === undefined ? undefined : toPartnerRequest(item);
  }

  // One conditional UpdateItem, so that "is it failed?" and "make it created" happen together.
  // The API writes only to the table (the outbox): the stream shows the change to the enqueuer,
  // which puts the request on the queue again (docs/api.md, "Sending a failed request again").
  async retry(ownerId: string, id: string): Promise<RetryOutcome> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: ownerKey(ownerId), sk: requestKey(id) },
          // ADD on a number that is not there yet starts from 0, so the first send stores 1.
          UpdateExpression: "SET #status = :created ADD retryCount :one",
          // Only a failed request may be sent again (the rule of request-status.ts). A missing
          // item has no status, so this fails for it too and no item is created;
          // attribute_exists(pk) only says so out loud.
          // `status` is a reserved word in DynamoDB expressions, hence the #status alias.
          ConditionExpression: "attribute_exists(pk) AND #status = :failed",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":created": "created", ":failed": "failed", ":one": 1 },
          // The whole item after the update: the answer is built from it, no second read.
          ReturnValues: "ALL_NEW",
          // If the condition fails, hand back the item as it is: its status (or its absence)
          // tells "not failed" from "not found" without a second read.
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
      return { kind: "restarted", request: toPartnerRequest(result.Attributes as RequestItem) };
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;

      // No item came back: there is no such key, so no such request for this owner (another
      // user's id is a different key, so it is "not found" too).
      if (error.Item === undefined) return { kind: "not_found" };

      // The document client does not convert what is in an exception, so it is in DynamoDB's
      // typed format ({ S: "..." }) and is unmarshalled here.
      const stored = unmarshall(error.Item) as RequestItem;
      return { kind: "not_failed", status: stored.status };
    }
  }
}
