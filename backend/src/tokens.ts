// Inversify binds by identifier. We use a unique symbol per dependency instead of the class
// itself, so code that asks for a "RequestRepository" never names the DynamoDB class, and
// tests or later stages can bind another implementation under the same symbol.
//
// The containers (src/container*.ts) are the only files that connect a symbol to a class.
// One symbol list serves all of them; a bundle only ever binds the symbols its function uses.
export const TOKENS = {
  // Configuration: one token per function kind, because each has its own set of variables.
  Config: Symbol("Config"), // the API functions
  ExchangeConfig: Symbol("ExchangeConfig"), // get-exchange
  EnqueuerConfig: Symbol("EnqueuerConfig"),
  WorkerConfig: Symbol("WorkerConfig"),
  WebhookConfig: Symbol("WebhookConfig"),

  Logger: Symbol("Logger"),

  // AWS SDK clients (created once per cold start)
  DynamoDocumentClient: Symbol("DynamoDocumentClient"),
  SqsClient: Symbol("SqsClient"),
  SnsClient: Symbol("SnsClient"),
  S3Client: Symbol("S3Client"),
  SsmClient: Symbol("SsmClient"),

  // Repositories, ports and clients
  RequestRepository: Symbol("RequestRepository"),
  DeliveryRepository: Symbol("DeliveryRepository"),
  DeliveryQueue: Symbol("DeliveryQueue"),
  StatusNotifier: Symbol("StatusNotifier"),
  ExchangeStore: Symbol("ExchangeStore"),
  ApiKeyProvider: Symbol("ApiKeyProvider"),
  DecisionRepository: Symbol("DecisionRepository"),
  WebhookToken: Symbol("WebhookToken"), // a SecretProvider
  XmlValidator: Symbol("XmlValidator"),
  PartnerClient: Symbol("PartnerClient"),

  // Services
  RequestService: Symbol("RequestService"),
  EnqueueService: Symbol("EnqueueService"),
  DeliveryService: Symbol("DeliveryService"),
  ExchangeService: Symbol("ExchangeService"),
  WebhookService: Symbol("WebhookService"),
} as const;
