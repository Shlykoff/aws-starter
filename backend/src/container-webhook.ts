import { SSMClient } from "@aws-sdk/client-ssm";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Container } from "inversify";
import type { XmlValidator } from "./clients/xml-validator";
import { XsdXmlValidator } from "./clients/xsd-xml-validator";
import { bindDynamoDocumentClient } from "./container-dynamodb";
import { bindLogger } from "./container-shared";
import { loadWebhookConfig } from "./lib/config";
import type { WebhookConfig } from "./lib/config";
import { tracedPort } from "./lib/tracing";
import { SCHEMAS_DIRECTORY } from "./lib/schemas-location";
import type { DecisionRepository } from "./repositories/decision-repository";
import { DynamoDecisionRepository } from "./repositories/dynamodb-decision-repository";
import type { SecretProvider } from "./repositories/secret-provider";
import { SsmApiKeyProvider } from "./repositories/ssm-api-key-provider";
import { WebhookService } from "./services/webhook-service";
import { TOKENS } from "./tokens";

// The dependency graph of the receive-webhook function. Built once per cold start, like
// container.ts (which explains the Inversify style used here).

// Fail fast: TABLE_NAME and WEBHOOK_TOKEN_PARAM must be set, or the function fails while it
// initialises.
const config = loadWebhookConfig(process.env);

export const container = new Container();

container.bind<WebhookConfig>(TOKENS.WebhookConfig).toConstantValue(config);
bindLogger(container, config.logLevel);
bindDynamoDocumentClient(container);
container.bind<SSMClient>(TOKENS.SsmClient).toConstantValue(new SSMClient({}));

container
  .bind<DecisionRepository>(TOKENS.DecisionRepository)
  .toResolvedValue(
    (client: DynamoDBDocumentClient, { tableName }: WebhookConfig) =>
      tracedPort(new DynamoDecisionRepository(client, tableName), "decisions"),
    [TOKENS.DynamoDocumentClient, TOKENS.WebhookConfig],
  )
  .inSingletonScope();

// The class that reads the partner API key for the worker also reads this token: it works for
// any SecureString parameter. One provider for the whole function, so that its 5-minute cache
// is shared by every call. The service only ever calls `get`, never `invalidate`.
container
  .bind<SecretProvider>(TOKENS.WebhookToken)
  .toResolvedValue(
    (client: SSMClient, { webhookTokenParam }: WebhookConfig) =>
      tracedPort(new SsmApiKeyProvider(client, webhookTokenParam), "webhook-token"),
    [TOKENS.SsmClient, TOKENS.WebhookConfig],
  )
  .inSingletonScope();

// Reads the four schema files here, once per cold start, not on every call.
container
  .bind<XmlValidator>(TOKENS.XmlValidator)
  .toResolvedValue(() => tracedPort(new XsdXmlValidator(SCHEMAS_DIRECTORY), "xml-validator"))
  .inSingletonScope();

container
  .bind<WebhookService>(TOKENS.WebhookService)
  .toResolvedValue(
    (token: SecretProvider, validator: XmlValidator, decisions: DecisionRepository) =>
      new WebhookService(token, validator, decisions),
    [TOKENS.WebhookToken, TOKENS.XmlValidator, TOKENS.DecisionRepository],
  )
  .inSingletonScope();
