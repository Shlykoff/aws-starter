import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import type { PartnerPayload } from "../domain/partner-payload";
import type { PartnerClient, PartnerResult } from "./partner-client";

// The partner is a Lambda Function URL with auth type AWS_IAM. AWS checks a SigV4
// signature on every request, so there is no public endpoint and no shared secret: the
// worker proves who it is with the credentials of its own IAM role.

// The worker has 15 s in total (docs/api.md). One slow partner must not eat all of it.
const TIMEOUT_MS = 8000;

// The signing name of Lambda function URLs is "lambda" (not "execute-api").
const SIGNING_SERVICE = "lambda";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * The credentials Lambda puts into the environment of every function, taken from the
 * function's execution role. They are read at signing time, not at start-up: the SDK
 * clients also find them lazily.
 */
export function credentialsFromEnv(env: Record<string, string | undefined> = process.env): AwsCredentials {
  const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (accessKeyId === undefined || accessKeyId === "" || secretAccessKey === undefined || secretAccessKey === "") {
    throw new Error("AWS credentials are missing from the environment");
  }
  return { accessKeyId, secretAccessKey, sessionToken: env.AWS_SESSION_TOKEN };
}

interface HttpPartnerClientOptions {
  /** The Function URL of the partner. */
  url: string;
  /** The region the URL lives in (the same region as the worker). */
  region: string;
  credentials: () => AwsCredentials;
  // The last two are parameters only so that tests can replace the network and the clock.
  fetch?: typeof fetch;
  now?: () => Date;
}

export class HttpPartnerClient implements PartnerClient {
  private readonly url: URL;
  private readonly signer: SignatureV4;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;

  constructor(options: HttpPartnerClientOptions) {
    this.url = new URL(options.url);
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.signer = new SignatureV4({
      service: SIGNING_SERVICE,
      region: options.region,
      credentials: () => Promise.resolve(options.credentials()),
      sha256: Sha256,
    });
  }

  async send(payload: PartnerPayload): Promise<PartnerResult> {
    const body = JSON.stringify(payload);
    const headers = await this.signedHeaders(payload.id, body);

    let response: Response;
    try {
      response = await this.fetch(this.url.href, {
        method: "POST",
        headers,
        body,
        // Never follow a redirect: the request is signed for this URL only.
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // Timeout, DNS or connection problem: the partner never answered. Try again later.
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return { kind: "retryable", reason: timedOut ? "timeout" : "network_error" };
    }

    // Only the status matters. Cancelling the body frees the connection for the next call.
    await response.body?.cancel().catch(() => undefined);
    return classify(response.status);
  }

  // The headers to send: Content-Type and Idempotency-Key, plus the ones the signature adds
  // (Authorization, X-Amz-Date, X-Amz-Security-Token, ...). The URL has no query string.
  private async signedHeaders(idempotencyKey: string, body: string): Promise<Record<string, string>> {
    const signed = await this.signer.sign(
      {
        method: "POST",
        protocol: this.url.protocol,
        hostname: this.url.hostname,
        path: this.url.pathname,
        query: {},
        // `host` is part of every signature. fetch sets it by itself, from the URL.
        headers: {
          host: this.url.host,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body,
      },
      { signingDate: this.now() },
    );

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(signed.headers)) {
      if (name !== "host") headers[name] = value;
    }
    return headers;
  }
}

// The 4xx answers that are NOT a final refusal (docs/api.md, "delivery-worker", step 2):
//   401, 403  come from AWS itself, in front of the partner's code: our own credentials or
//             permissions are wrong (the role, the Function URL policy, the signature). That
//             is our fault and can be fixed, so it must not end as a silent "rejected": it is
//             retried and, if it never works, ends as "failed" with an alarm.
//   408, 429  the partner gave up waiting for us, or asks us to slow down: temporary.
const RETRYABLE_CLIENT_ERRORS = [401, 403, 408, 429];

// The rule of docs/api.md ("delivery-worker", step 2), in one place.
function classify(statusCode: number): PartnerResult {
  if (statusCode >= 200 && statusCode < 300) return { kind: "delivered", statusCode };

  // Every 5xx is temporary by nature.
  if (statusCode >= 500 || RETRYABLE_CLIENT_ERRORS.includes(statusCode)) {
    return { kind: "retryable", reason: `http_${statusCode}`, statusCode };
  }

  // Any other 4xx (400, 404, 422, ...): the partner understood the request and refused it.
  // Sending the same thing again would get the same answer.
  if (statusCode >= 400) return { kind: "rejected", statusCode };

  // 1xx and 3xx cannot be the final answer of a POST that does not follow redirects. If one
  // ever shows up, retrying is safer than declaring the request refused.
  return { kind: "retryable", reason: `http_${statusCode}`, statusCode };
}
