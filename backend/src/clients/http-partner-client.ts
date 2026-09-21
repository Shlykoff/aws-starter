import type { PartnerAnswer } from "../domain/partner-answer";
import type { PartnerClient, PartnerSubmission } from "./partner-client";

// The HTTP side of contracts/partner-api.md: POST /v1/submissions with an API key. Nothing
// here is written to the logs: the key, the URL, the headers and the bodies stay out.

// The worker has 15 s in total (docs/api.md). One slow recipient must not eat all of it.
const TIMEOUT_MS = 8000;

// The reply is untrusted input. The contract limits a Reply to be small, so anything above
// 64 KiB is not a Reply, and reading more than that would only waste memory.
export const MAX_REPLY_BYTES = 64 * 1024;

const SUBMISSIONS_PATH = "/v1/submissions";
const USER_AGENT = "aws-starter-worker/1";

interface HttpPartnerClientOptions {
  /** PARTNER_URL: scheme, host and port only (lib/config.ts checks it). The path is added here. */
  baseUrl: string;
  // A parameter only so that tests can replace the network. Production uses the global fetch
  // of Node 24, so no HTTP library is needed.
  fetch?: typeof fetch;
}

export class HttpPartnerClient implements PartnerClient {
  private readonly endpoint: URL;
  private readonly fetch: typeof fetch;

  constructor(options: HttpPartnerClientOptions) {
    this.endpoint = new URL(SUBMISSIONS_PATH, options.baseUrl);
    this.fetch = options.fetch ?? fetch;
  }

  async send({ xml, idempotencyKey, apiKey }: PartnerSubmission): Promise<PartnerAnswer> {
    let response: Response;
    try {
      response = await this.fetch(this.endpoint.href, {
        method: "POST",
        headers: {
          "X-API-Key": apiKey,
          // Only the media type counts to the recipient; the document's own XML declaration
          // says UTF-8, and `fetch` sends a string body as UTF-8.
          "Content-Type": "application/xml",
          "Idempotency-Key": idempotencyKey,
          "User-Agent": USER_AGENT,
          Accept: "application/xml",
        },
        body: xml,
        // Never follow a redirect: the request carries the API key, and a redirect could send
        // it to another host. With "manual" the 3xx answer comes back as it is, and the reply
        // reader treats it as a failure.
        redirect: "manual",
        // The limit covers connecting, waiting for the answer AND reading its body.
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // Timeout, DNS or connection problem: nobody answered. (The error is not kept: its
      // text can contain the host name.)
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return { kind: "no-answer", reason: timedOut ? "timeout" : "network_error" };
    }

    return { kind: "answer", httpStatus: response.status, ...(await readBody(response)) };
  }
}

type Body = { body: string | undefined; bodyProblem?: "too_large" | "unreadable" };

// Reads the body as text, but never more than MAX_REPLY_BYTES. It reads the stream chunk by
// chunk and stops at the limit, instead of `response.text()`, which would buffer a body of
// any size before we could look at it.
async function readBody(response: Response): Promise<Body> {
  if (response.body === null) return { body: undefined };

  // The cheap check first: a recipient that announces too much is not read at all.
  const announced = Number(response.headers.get("content-length"));
  if (announced > MAX_REPLY_BYTES) {
    await response.body.cancel().catch(() => undefined);
    return { body: undefined, bodyProblem: "too_large" };
  }

  // The header may be missing (chunked answers) or wrong, so the bytes that really arrive
  // are counted as well.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REPLY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { body: undefined, bodyProblem: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    // The connection broke, or the 8 s ran out, while the body was coming in. The status
    // code is still known, so the answer is kept and only the body is lost.
    return { body: undefined, bodyProblem: "unreadable" };
  }

  if (total === 0) return { body: undefined };
  try {
    // `fatal`: bytes that are not UTF-8 are an error, not silently replaced by U+FFFD.
    return { body: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch {
    return { body: undefined, bodyProblem: "unreadable" };
  }
}
