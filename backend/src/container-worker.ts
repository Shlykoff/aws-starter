import { S3Client } from "@aws-sdk/client-s3";
import { SNSClient } from "@aws-sdk/client-sns";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Container } from "inversify";
import { HttpPartnerClient, credentialsFromEnv } from "./clients/http-partner-client";
import type { PartnerClient } from "./clients/partner-client";
import { bindDynamoDocumentClient } from "./container-dynamodb";
import { bindLogger } from "./container-shared";
import { loadWorkerConfig } from "./lib/config";
import type { WorkerConfig } from "./lib/config";
import type { AuditStore } from "./repositories/audit-store";
import type { DeliveryRepository } from "./repositories/delivery-repository";
import { DynamoDeliveryRepository } from "./repositories/dynamodb-delivery-repository";
import { S3AuditStore } from "./repositories/s3-audit-store";
import { SnsStatusNotifier } from "./repositories/sns-status-notifier";
import type { StatusNotifier } from "./repositories/status-notifier";
import { DeliveryService } from "./services/delivery-service";
import { TOKENS } from "./tokens";

// The dependency graph of the delivery-worker function. Built once per cold start, like
// container.ts (which explains the Inversify style used here).

// Fail fast: if any of the five variables of the worker is missing or malformed (for example
// MAX_RECEIVE_COUNT is not a positive integer), the function fails while it initialises.
const config = loadWorkerConfig(process.env);

export const container = new Container();

container.bind<WorkerConfig>(TOKENS.WorkerConfig).toConstantValue(config);
bindLogger(container, config.logLevel);
bindDynamoDocumentClient(container);
container.bind<SNSClient>(TOKENS.SnsClient).toConstantValue(new SNSClient({}));
container.bind<S3Client>(TOKENS.S3Client).toConstantValue(new S3Client({}));

container
  .bind<DeliveryRepository>(TOKENS.DeliveryRepository)
  .toResolvedValue(
    (client: DynamoDBDocumentClient, { tableName }: WorkerConfig) =>
      new DynamoDeliveryRepository(client, tableName),
    [TOKENS.DynamoDocumentClient, TOKENS.WorkerConfig],
  )
  .inSingletonScope();

container
  .bind<StatusNotifier>(TOKENS.StatusNotifier)
  .toResolvedValue(
    (client: SNSClient, { topicArn }: WorkerConfig) => new SnsStatusNotifier(client, topicArn),
    [TOKENS.SnsClient, TOKENS.WorkerConfig],
  )
  .inSingletonScope();

container
  .bind<AuditStore>(TOKENS.AuditStore)
  .toResolvedValue(
    (client: S3Client, { auditBucket }: WorkerConfig) => new S3AuditStore(client, auditBucket),
    [TOKENS.S3Client, TOKENS.WorkerConfig],
  )
  .inSingletonScope();

// The request to the partner is signed with the credentials of this function's own role.
container
  .bind<PartnerClient>(TOKENS.PartnerClient)
  .toResolvedValue(
    ({ partnerUrl, region }: WorkerConfig) =>
      new HttpPartnerClient({ url: partnerUrl, region, credentials: () => credentialsFromEnv() }),
    [TOKENS.WorkerConfig],
  )
  .inSingletonScope();

container
  .bind<DeliveryService>(TOKENS.DeliveryService)
  .toResolvedValue(
    (
      repository: DeliveryRepository,
      partner: PartnerClient,
      audit: AuditStore,
      notifier: StatusNotifier,
      { maxReceiveCount }: WorkerConfig,
    ) => new DeliveryService(repository, partner, audit, notifier, maxReceiveCount),
    [
      TOKENS.DeliveryRepository,
      TOKENS.PartnerClient,
      TOKENS.AuditStore,
      TOKENS.StatusNotifier,
      TOKENS.WorkerConfig,
    ],
  )
  .inSingletonScope();
