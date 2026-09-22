import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Container } from "inversify";
import { bindDynamoDocumentClient } from "./container-dynamodb";
import { bindLogger } from "./container-shared";
import { CognitoSenderIdentityProvider } from "./repositories/cognito-sender-identity-provider";
import { DynamoRequestRepository } from "./repositories/dynamodb-request-repository";
import type { RequestRepository } from "./repositories/request-repository";
import type { SenderIdentityProvider } from "./repositories/sender-identity-provider";
import { RequestService } from "./services/request-service";
import { loadConfig } from "./lib/config";
import type { Config } from "./lib/config";
import { tracedPort } from "./lib/tracing";
import { TOKENS } from "./tokens";

// The dependency graph of the four request functions (create-request, list-requests,
// get-request, retry-request), wired in one place. The other functions have their own containers:
// container-exchange.ts, container-enqueuer.ts and container-worker.ts (see
// container-shared.ts for why there is one per function kind).
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
//   - Every port that talks to AWS or to the partner is wrapped once, here, by `tracedPort`
//     (lib/tracing.ts): each call of its methods becomes a span named `<label>.<method>`.

// Fail fast: if TABLE_NAME is missing this throws while the function initialises.
const config = loadConfig(process.env);

export const container = new Container();

container.bind<Config>(TOKENS.Config).toConstantValue(config);

bindLogger(container, config.logLevel);
bindDynamoDocumentClient(container);
// Only create-request calls this (to read the caller's own e-mail via GetUser), but the four
// request functions share this one container file, so list/get/retry also construct the client
// and the port; they never call it, and no command is sent until `.getEmail` actually runs.
container
  .bind<CognitoIdentityProviderClient>(TOKENS.CognitoClient)
  .toConstantValue(new CognitoIdentityProviderClient({}));

container
  .bind<RequestRepository>(TOKENS.RequestRepository)
  .toResolvedValue(
    (client: DynamoDBDocumentClient, { tableName }: Config) =>
      tracedPort(new DynamoRequestRepository(client, tableName), "requests"),
    [TOKENS.DynamoDocumentClient, TOKENS.Config],
  )
  .inSingletonScope();

container
  .bind<SenderIdentityProvider>(TOKENS.SenderIdentityProvider)
  .toResolvedValue(
    (client: CognitoIdentityProviderClient) =>
      tracedPort(new CognitoSenderIdentityProvider(client), "sender-identity"),
    [TOKENS.CognitoClient],
  )
  .inSingletonScope();

container
  .bind<RequestService>(TOKENS.RequestService)
  .toResolvedValue(
    (repository: RequestRepository, identity: SenderIdentityProvider) => new RequestService(repository, identity),
    [TOKENS.RequestRepository, TOKENS.SenderIdentityProvider],
  )
  .inSingletonScope();
