import { PutObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import type { LogArchiveStore } from "./log-archive-store";

// Writes the objects of the log archive (`logs/year=.../month=.../day=.../<hash>.json.gz`).
// The bucket is private, encrypted by default and expires objects after a retention period (Terraform).
export class S3LogArchiveStore implements LogArchiveStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, body: Uint8Array): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        // The content is JSON lines. There is no ContentEncoding: Athena recognises the
        // compression by the ".gz" in the name, and with "gzip" set here, some readers
        // (an SDK, a browser) would unpack the object silently and hand over the wrong bytes.
        ContentType: "application/json",
        // No encryption setting here: the bucket's default encryption applies.
      }),
    );
  }
}
