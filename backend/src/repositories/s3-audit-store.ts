import { PutObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import type { AuditCopy, AuditStore } from "./audit-store";

export class S3AuditStore implements AuditStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async save(requestId: string, copy: AuditCopy): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        // One object per request. A retry writes the same key, so it overwrites the
        // earlier copy instead of leaving duplicates. Encryption comes from the bucket's
        // default setting (Terraform).
        Key: `deliveries/${requestId}.json`,
        Body: JSON.stringify({
          sentAt: copy.sentAt,
          payload: copy.payload,
          partnerStatus: copy.partnerStatus,
        }),
        ContentType: "application/json",
      }),
    );
  }
}
