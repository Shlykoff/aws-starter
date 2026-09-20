import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { Container } from "inversify";
import { bindDynamoDocumentClient } from "./container-dynamodb";
import { bindLogger } from "./container-shared";
import { loadEnqueuerConfig } from "./lib/config";
import type { EnqueuerConfig } from "./lib/config";
import { DynamoDeliveryRepository } from "./repositories/dynamodb-delivery-repository";
import type { DeliveryQueue } from "./repositories/delivery-queue";
import type { DeliveryRepository } from "./repositories/delivery-repository";
import { SqsDeliveryQueue } from "./repositories/sqs-delivery-queue";
import { EnqueueService } from "./services/enqueue-service";
import { TOKENS } from "./tokens";

// The dependency graph of the enqueuer function. Built once per cold start, like
// container.ts (which explains the Inversify style used here).

// Fail fast: TABLE_NAME and QUEUE_URL must be set, or the function fails while it initialises.
const config = loadEnqueuerConfig(process.env);

export const container = new Container();

container.bind<EnqueuerConfig>(TOKENS.EnqueuerConfig).toConstantValue(config);
bindLogger(container, config.logLevel);
bindDynamoDocumentClient(container);
container.bind<SQSClient>(TOKENS.SqsClient).toConstantValue(new SQSClient({}));

container
  .bind<DeliveryRepository>(TOKENS.DeliveryRepository)
  .toResolvedValue(
    (client: DynamoDBDocumentClient, { tableName }: EnqueuerConfig) =>
      new DynamoDeliveryRepository(client, tableName),
    [TOKENS.DynamoDocumentClient, TOKENS.EnqueuerConfig],
  )
  .inSingletonScope();

container
  .bind<DeliveryQueue>(TOKENS.DeliveryQueue)
  .toResolvedValue(
    (client: SQSClient, { queueUrl }: EnqueuerConfig) => new SqsDeliveryQueue(client, queueUrl),
    [TOKENS.SqsClient, TOKENS.EnqueuerConfig],
  )
  .inSingletonScope();

container
  .bind<EnqueueService>(TOKENS.EnqueueService)
  .toResolvedValue(
    (queue: DeliveryQueue, repository: DeliveryRepository) => new EnqueueService(queue, repository),
    [TOKENS.DeliveryQueue, TOKENS.DeliveryRepository],
  )
  .inSingletonScope();
