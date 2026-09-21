import { S3Client } from "@aws-sdk/client-s3";
import { Container } from "inversify";
import { bindLogger } from "./container-shared";
import { loadArchiverConfig } from "./lib/config";
import type { ArchiverConfig } from "./lib/config";
import type { LogArchiveStore } from "./repositories/log-archive-store";
import { S3LogArchiveStore } from "./repositories/s3-log-archive-store";
import { LogArchiveService } from "./services/log-archive-service";
import { TOKENS } from "./tokens";

// The dependency graph of the log-archiver function. Built once per cold start, like
// container.ts (which explains the Inversify style used here). It needs no table.

// Fail fast: ARCHIVE_BUCKET must be set, or the function fails while it initialises.
const config = loadArchiverConfig(process.env);

export const container = new Container();

container.bind<ArchiverConfig>(TOKENS.ArchiverConfig).toConstantValue(config);
bindLogger(container, config.logLevel);
container.bind<S3Client>(TOKENS.S3Client).toConstantValue(new S3Client({}));

container
  .bind<LogArchiveStore>(TOKENS.LogArchiveStore)
  .toResolvedValue(
    (client: S3Client, { archiveBucket }: ArchiverConfig) => new S3LogArchiveStore(client, archiveBucket),
    [TOKENS.S3Client, TOKENS.ArchiverConfig],
  )
  .inSingletonScope();

container
  .bind<LogArchiveService>(TOKENS.LogArchiveService)
  .toResolvedValue((store: LogArchiveStore) => new LogArchiveService(store), [TOKENS.LogArchiveStore])
  .inSingletonScope();
