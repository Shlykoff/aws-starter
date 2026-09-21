import { S3Client } from "@aws-sdk/client-s3";
import { SNSClient } from "@aws-sdk/client-sns";
import { SSMClient } from "@aws-sdk/client-ssm";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Container } from "inversify";
import { HttpPartnerClient } from "./clients/http-partner-client";
import type { PartnerClient } from "./clients/partner-client";
import type { XmlValidator } from "./clients/xml-validator";
import { XsdXmlValidator } from "./clients/xsd-xml-validator";
import { bindDynamoDocumentClient } from "./container-dynamodb";
import { bindLogger } from "./container-shared";
import { loadWorkerConfig } from "./lib/config";
import type { WorkerConfig } from "./lib/config";
import { SCHEMAS_DIRECTORY } from "./lib/schemas-location";
import type { ApiKeyProvider } from "./repositories/api-key-provider";
import type { DeliveryRepository } from "./repositories/delivery-repository";
import { DynamoDeliveryRepository } from "./repositories/dynamodb-delivery-repository";
import type { ExchangeStore } from "./repositories/exchange-store";
import { S3ExchangeStore } from "./repositories/s3-exchange-store";
import { SnsStatusNotifier } from "./repositories/sns-status-notifier";
import { SsmApiKeyProvider } from "./repositories/ssm-api-key-provider";
import type { StatusNotifier } from "./repositories/status-notifier";
import { DeliveryService } from "./services/delivery-service";
import { TOKENS } from "./tokens";

// The dependency graph of the delivery-worker function. Built once per cold start, like
// container.ts (which explains the Inversify style used here).

// Fail fast: if any variable of the worker is missing or malformed (for example
// MAX_RECEIVE_COUNT is not a positive integer, or PARTNER_URL is not https), the function
// fails while it initialises.
const config = loadWorkerConfig(process.env);

export const container = new Container();

container.bind<WorkerConfig>(TOKENS.WorkerConfig).toConstantValue(config);
bindLogger(container, config.logLevel);
bindDynamoDocumentClient(container);
container.bind<SNSClient>(TOKENS.SnsClient).toConstantValue(new SNSClient({}));
container.bind<S3Client>(TOKENS.S3Client).toConstantValue(new S3Client({}));
container.bind<SSMClient>(TOKENS.SsmClient).toConstantValue(new SSMClient({}));

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
  .bind<ExchangeStore>(TOKENS.ExchangeStore)
  .toResolvedValue(
    (client: S3Client, { auditBucket }: WorkerConfig) => new S3ExchangeStore(client, auditBucket),
    [TOKENS.S3Client, TOKENS.WorkerConfig],
  )
  .inSingletonScope();

// One provider for the whole function, so that its 5-minute cache is shared by every message.
container
  .bind<ApiKeyProvider>(TOKENS.ApiKeyProvider)
  .toResolvedValue(
    (client: SSMClient, { partnerApiKeyParam }: WorkerConfig) =>
      new SsmApiKeyProvider(client, partnerApiKeyParam),
    [TOKENS.SsmClient, TOKENS.WorkerConfig],
  )
  .inSingletonScope();

// Reads the three schema files here, once per cold start, not on every message.
container
  .bind<XmlValidator>(TOKENS.XmlValidator)
  .toResolvedValue(() => new XsdXmlValidator(SCHEMAS_DIRECTORY))
  .inSingletonScope();

container
  .bind<PartnerClient>(TOKENS.PartnerClient)
  .toResolvedValue(({ partnerUrl }: WorkerConfig) => new HttpPartnerClient({ baseUrl: partnerUrl }), [
    TOKENS.WorkerConfig,
  ])
  .inSingletonScope();

container
  .bind<DeliveryService>(TOKENS.DeliveryService)
  .toResolvedValue(
    (
      repository: DeliveryRepository,
      partner: PartnerClient,
      validator: XmlValidator,
      apiKeys: ApiKeyProvider,
      exchanges: ExchangeStore,
      notifier: StatusNotifier,
      { senderName, maxReceiveCount }: WorkerConfig,
    ) =>
      new DeliveryService(repository, partner, validator, apiKeys, exchanges, notifier, {
        senderName,
        maxReceiveCount,
      }),
    [
      TOKENS.DeliveryRepository,
      TOKENS.PartnerClient,
      TOKENS.XmlValidator,
      TOKENS.ApiKeyProvider,
      TOKENS.ExchangeStore,
      TOKENS.StatusNotifier,
      TOKENS.WorkerConfig,
    ],
  )
  .inSingletonScope();
