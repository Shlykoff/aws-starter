// Inversify binds by identifier. We use a unique symbol per dependency instead of the class
// itself, so code that asks for a "RequestRepository" never names the DynamoDB class, and
// tests or later stages can bind another implementation under the same symbol.
//
// The container (src/container.ts) is the only file that connects a symbol to a class.
export const TOKENS = {
  Config: Symbol("Config"),
  Logger: Symbol("Logger"),
  DynamoDocumentClient: Symbol("DynamoDocumentClient"),
  RequestRepository: Symbol("RequestRepository"),
  RequestService: Symbol("RequestService"),
} as const;
