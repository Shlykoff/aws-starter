import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Container } from "inversify";
import { TOKENS } from "./tokens";

// The DynamoDB binding shared by the API functions, the enqueuer and the delivery-worker
// (see container-shared.ts for why the containers are split per function).
//
// One SDK client per environment, created outside any handler. It reuses its HTTPS
// connections between invocations. The region comes from AWS_REGION, which Lambda sets.
export function bindDynamoDocumentClient(container: Container): void {
  container
    .bind<DynamoDBDocumentClient>(TOKENS.DynamoDocumentClient)
    .toConstantValue(DynamoDBDocumentClient.from(new DynamoDBClient({})));
}
