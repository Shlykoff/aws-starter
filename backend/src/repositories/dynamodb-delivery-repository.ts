import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { PartnerRequest, RequestStatus } from "../domain/request";
import { ownerKey, requestKey } from "../domain/request-keys";
import { allowedPreviousStatuses } from "../domain/request-status";
import type { DeliveryRepository } from "./delivery-repository";

// The same table and keys as DynamoRequestRepository (see the comment above that class:
// pk = USER#<sub>, sk = REQ#<ULID>). Access patterns of the delivery side:
//
//   4. Read one request before delivering it   -> GetItem    (pk, sk), ConsistentRead
//   5. Change the status of one request        -> UpdateItem (pk, sk), conditional
//
// (Patterns 1-3 are the API's; see dynamodb-request-repository.ts.)
//
// Why a consistent read: the worker often runs moments after the item was written, and
// an eventually consistent GetItem could still answer "not found" or show an old status.
// It costs one full read unit instead of half, which is fine at this volume.

export class DynamoDeliveryRepository implements DeliveryRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async findForDelivery(ownerId: string, id: string): Promise<PartnerRequest | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: ownerKey(ownerId), sk: requestKey(id) },
        ConsistentRead: true,
      }),
    );

    // Only this project's code writes to the table, so the stored shape is known. The
    // fields are copied one by one, so the key attributes (which hold the owner) are
    // dropped, like in the API repository.
    const item = result.Item as PartnerRequest | undefined;
    if (item === undefined) return undefined;
    return {
      id: item.id,
      partner: item.partner,
      subject: item.subject,
      body: item.body,
      status: item.status,
      createdAt: item.createdAt,
    };
  }

  markQueued(ownerId: string, id: string): Promise<boolean> {
    return this.moveTo("queued", ownerId, id);
  }

  markSent(ownerId: string, id: string): Promise<boolean> {
    return this.moveTo("sent", ownerId, id);
  }

  markRejected(ownerId: string, id: string): Promise<boolean> {
    return this.moveTo("rejected", ownerId, id);
  }

  markFailed(ownerId: string, id: string): Promise<boolean> {
    return this.moveTo("failed", ownerId, id);
  }

  // One conditional UpdateItem: "set status = :to, but only if the current status is one
  // of the statuses that may lead to :to". DynamoDB checks and writes atomically, so two
  // workers (or a worker and the enqueuer) cannot overwrite each other's result.
  private async moveTo(to: RequestStatus, ownerId: string, id: string): Promise<boolean> {
    const from = allowedPreviousStatuses(to);

    // `status` is a reserved word in DynamoDB expressions, hence the #status alias.
    // The allowed values become :from0, :from1, ... because IN needs one placeholder each.
    const values: Record<string, RequestStatus> = { ":to": to };
    from.forEach((status, index) => {
      values[`:from${index}`] = status;
    });
    const placeholders = from.map((_, index) => `:from${index}`).join(", ");

    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: ownerKey(ownerId), sk: requestKey(id) },
          UpdateExpression: "SET #status = :to",
          // This also protects against a missing item: UpdateItem would otherwise create
          // one. A missing item has no status, so the condition fails and nothing is written.
          ConditionExpression: `#status IN (${placeholders})`,
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: values,
        }),
      );
      return true;
    } catch (error) {
      // The condition failed: the request is not in a status that may lead to `to`.
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }
}
