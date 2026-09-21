import { GetObjectCommand, NoSuchKey, PutObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { exchangeSchema } from "../domain/exchange";
import type { Exchange } from "../domain/exchange";
import type { ExchangeStore } from "./exchange-store";

// One object per request: `exchanges/<requestId>.json` in the deliveries bucket (docs/api.md).
// A repeated attempt writes the same key, so the object always describes the latest attempt
// and a reader never sees the request of one attempt next to the reply of another.
// The bucket is private, encrypted by default and expires objects after 30 days (Terraform).
const keyOf = (requestId: string): string => `exchanges/${requestId}.json`;

export class S3ExchangeStore implements ExchangeStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async save(requestId: string, exchange: Exchange): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: keyOf(requestId),
        Body: JSON.stringify(exchange),
        ContentType: "application/json; charset=utf-8",
        // No encryption setting here: the bucket's default encryption applies.
      }),
    );
  }

  async find(requestId: string): Promise<Exchange | undefined> {
    let text: string;
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: keyOf(requestId) }),
      );
      text = (await response.Body?.transformToString("utf-8")) ?? "";
    } catch (error) {
      // Only "there is no such object" means "no delivery attempt yet". Everything else, an
      // AccessDenied above all, is thrown: a missing permission must show up as an error
      // (a 500 and a log line), and not pass for a request that was never delivered.
      // (Without s3:ListBucket, S3 answers a missing key with 403, not NoSuchKey.)
      if (error instanceof NoSuchKey) return undefined;
      throw error;
    }

    // The object is data we wrote ourselves, but it is checked when it is read: an object
    // written by an older or a newer version of the code must fail here, loudly, and not send
    // a wrong shape to a client. The messages below are fixed: the object holds the text of
    // the request, and the message of a JSON or zod error may quote it.
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("The stored exchange is not valid JSON");
    }
    const parsed = exchangeSchema.safeParse(json);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
      throw new Error(`The stored exchange does not match the expected shape (${fields})`);
    }
    return parsed.data;
  }
}
