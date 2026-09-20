import type { Container } from "inversify";
import type { LogLevel } from "./lib/config";
import { createLogger } from "./lib/logger";
import type { Logger } from "./lib/logger";
import { TOKENS } from "./tokens";

// The bindings that more than one function needs. Every function has its own container file
// (container.ts for the API functions, container-enqueuer.ts, container-worker.ts and
// container-mock.ts), because each one:
//   - validates only ITS OWN environment variables (a function must not fail to start
//     because a variable of another function is missing), and
//   - is bundled into its own Lambda, so it should contain only the AWS clients it uses.
// What is really identical everywhere lives in the container-shared*.ts files. The
// DynamoDB client has its own file (container-dynamodb.ts) so that the partner mock,
// which needs no AWS client, does not bundle the DynamoDB SDK just for a logger.

export function bindLogger(container: Container, logLevel: LogLevel): void {
  container.bind<Logger>(TOKENS.Logger).toConstantValue(createLogger(logLevel));
}
