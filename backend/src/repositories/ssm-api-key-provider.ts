import { GetParameterCommand } from "@aws-sdk/client-ssm";
import type { SSMClient } from "@aws-sdk/client-ssm";
import type { ApiKeyProvider } from "./api-key-provider";

// The key is a SecureString parameter in SSM Parameter Store (docs/api.md, "The recipient").
// It is read once and kept in memory for 5 minutes: a warm Lambda environment handles many
// messages, and asking SSM for every one of them would cost time and count against its
// request limits, while a rotated key is picked up within minutes (or at once after a 401,
// see `invalidate`).
const CACHE_MS = 5 * 60 * 1000;

export class SsmApiKeyProvider implements ApiKeyProvider {
  private cached: { value: string; expiresAt: number } | undefined;
  // The read that is running right now, if any: callers that arrive meanwhile wait for it
  // instead of starting their own.
  private inFlight: Promise<string> | undefined;
  // Counts the calls of `invalidate`, so a read that started before one is recognised.
  private generation = 0;

  constructor(
    private readonly client: SSMClient,
    private readonly parameterName: string,
    // A parameter only so that tests can fix the clock (milliseconds).
    private readonly now: () => number = Date.now,
  ) {}

  get(): Promise<string> {
    if (this.cached !== undefined && this.now() < this.cached.expiresAt) {
      return Promise.resolve(this.cached.value);
    }
    if (this.inFlight === undefined) {
      const reading = this.read().finally(() => {
        // Only forget OUR read: `invalidate` may have started another one in the meantime.
        if (this.inFlight === reading) this.inFlight = undefined;
      });
      this.inFlight = reading;
    }
    return this.inFlight;
  }

  invalidate(): void {
    this.cached = undefined;
    this.inFlight = undefined;
    this.generation += 1;
  }

  private async read(): Promise<string> {
    const generation = this.generation;
    const response = await this.client.send(
      // WithDecryption: the parameter is a SecureString, encrypted with KMS.
      new GetParameterCommand({ Name: this.parameterName, WithDecryption: true }),
    );
    const value = response.Parameter?.Value;
    if (value === undefined || value === "") {
      throw new Error("The API key parameter has no value");
    }

    // A failure never gets here, so it is never cached: the next call tries again. And if
    // `invalidate` ran while we were reading, this value may be the OLD key: it serves the
    // callers that were waiting for it, but it is not kept.
    if (generation === this.generation) {
      this.cached = { value, expiresAt: this.now() + CACHE_MS };
    }
    return value;
  }
}
