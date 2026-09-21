import { S3Client } from "@aws-sdk/client-s3";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Container } from "inversify";
import { bindDynamoDocumentClient } from "./container-dynamodb";
import { bindLogger } from "./container-shared";
import { loadExchangeConfig } from "./lib/config";
import type { ExchangeConfig } from "./lib/config";
import { tracedPort } from "./lib/tracing";
import { DynamoRequestRepository } from "./repositories/dynamodb-request-repository";
import type { ExchangeStore } from "./repositories/exchange-store";
import type { RequestRepository } from "./repositories/request-repository";
import { S3ExchangeStore } from "./repositories/s3-exchange-store";
import { ExchangeService } from "./services/exchange-service";
import { TOKENS } from "./tokens";

// The dependency graph of the get-exchange function. Built once per cold start, like
// container.ts (which explains the Inversify style used here).

// Fail fast: TABLE_NAME and AUDIT_BUCKET must be set, or the function fails while it initialises.
const config = loadExchangeConfig(process.env);

export const container = new Container();

container.bind<ExchangeConfig>(TOKENS.ExchangeConfig).toConstantValue(config);
bindLogger(container, config.logLevel);
bindDynamoDocumentClient(container);
container.bind<S3Client>(TOKENS.S3Client).toConstantValue(new S3Client({}));

// The table answers "is this request the caller's?", S3 holds the record itself.
container
  .bind<RequestRepository>(TOKENS.RequestRepository)
  .toResolvedValue(
    (client: DynamoDBDocumentClient, { tableName }: ExchangeConfig) =>
      tracedPort(new DynamoRequestRepository(client, tableName), "requests"),
    [TOKENS.DynamoDocumentClient, TOKENS.ExchangeConfig],
  )
  .inSingletonScope();

container
  .bind<ExchangeStore>(TOKENS.ExchangeStore)
  .toResolvedValue(
    (client: S3Client, { auditBucket }: ExchangeConfig) =>
      tracedPort(new S3ExchangeStore(client, auditBucket), "exchanges"),
    [TOKENS.S3Client, TOKENS.ExchangeConfig],
  )
  .inSingletonScope();

container
  .bind<ExchangeService>(TOKENS.ExchangeService)
  .toResolvedValue(
    (requests: RequestRepository, exchanges: ExchangeStore) => new ExchangeService(requests, exchanges),
    [TOKENS.RequestRepository, TOKENS.ExchangeStore],
  )
  .inSingletonScope();
