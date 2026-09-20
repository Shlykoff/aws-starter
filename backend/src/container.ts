import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Container } from "inversify";
import { DynamoRequestRepository } from "./repositories/dynamodb-request-repository";
import type { RequestRepository } from "./repositories/request-repository";
import { RequestService } from "./services/request-service";
import { loadConfig } from "./lib/config";
import type { Config } from "./lib/config";
import { createLogger } from "./lib/logger";
import type { Logger } from "./lib/logger";
import { TOKENS } from "./tokens";

// The dependency graph of the whole backend, wired in one place.
//
// This module runs once per Lambda cold start (a Lambda execution environment imports it
// during its init phase) and the container lives as long as that environment. Warm
// invocations reuse everything built here: the config, the AWS SDK client and its
// connections, the repository and the service.
//
// Inversify setup, and why it looks the way it does:
//   - Inversify 8. Bindings are `toResolvedValue(factory, [tokens])`: "to build this, call
//     this function with the values bound to these tokens". So the classes stay plain
//     TypeScript. No @injectable()/@inject() decorators, therefore no
//     `experimentalDecorators` in tsconfig and no decorator metadata to configure.
//   - Inversify loads the `reflect-metadata` polyfill by itself (it imports
//     `reflect-metadata/lite`), so we never import it. It is listed in package.json only
//     because Inversify declares it as a peer dependency.
//   - Everything is a singleton, so one repository and one service serve all invocations.

// Fail fast: if TABLE_NAME is missing this throws while the function initialises.
const config = loadConfig(process.env);

export const container = new Container();

container.bind<Config>(TOKENS.Config).toConstantValue(config);

container.bind<Logger>(TOKENS.Logger).toConstantValue(createLogger(config.logLevel));

// One SDK client per environment, created outside any handler. It reuses its HTTPS
// connections between invocations. The region comes from AWS_REGION, which Lambda sets.
container
  .bind<DynamoDBDocumentClient>(TOKENS.DynamoDocumentClient)
  .toConstantValue(DynamoDBDocumentClient.from(new DynamoDBClient({})));

container
  .bind<RequestRepository>(TOKENS.RequestRepository)
  .toResolvedValue(
    (client: DynamoDBDocumentClient, { tableName }: Config) =>
      new DynamoRequestRepository(client, tableName),
    [TOKENS.DynamoDocumentClient, TOKENS.Config],
  )
  .inSingletonScope();

container
  .bind<RequestService>(TOKENS.RequestService)
  .toResolvedValue(
    (repository: RequestRepository) => new RequestService(repository),
    [TOKENS.RequestRepository],
  )
  .inSingletonScope();
