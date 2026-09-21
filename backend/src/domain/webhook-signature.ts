import { createHmac, timingSafeEqual } from "node:crypto";

// The signature of the webhook (contracts/webhook-api.md, "The request"). Pure functions:
// no I/O, no clock of their own, no logging.
//
//   X-Webhook-Timestamp  the time the request was signed: whole seconds, decimal digits only
//   X-Webhook-Signature  "v1=" + 64 lower-case hex digits of
//                        HMAC-SHA256(key = token as UTF-8, message = timestamp text + "." + body bytes)
//
// The check has two steps, because the handler must not ask SSM for the token before the
// request has passed the cheap tests: anybody on the internet can call this route, and
// unauthenticated junk must not cost a call to SSM.
//   1. `checkSignatureHeaders`: the shape of the two headers and the age of the request. No token.
//   2. `signatureMatches`: the HMAC itself. Needs the token.

// The signed request may be at most this many seconds older or newer than our clock (the
// contract says 300). It limits how long a captured request can be replayed. It has nothing to
// do with when the client acted: that is the `OccurredAt` inside the body.
export const MAX_CLOCK_DIFFERENCE_SECONDS = 300;

/** Why a request is not authenticated. A closed list of fixed words: safe to log. */
export type SignatureProblem =
  | "missing_timestamp"
  | "bad_timestamp" // not decimal digits only
  | "timestamp_out_of_range" // more than 300 s away from our clock, in either direction
  | "missing_signature"
  | "bad_signature_format" // not "v1=" + exactly 64 lower-case hex digits
  | "signature_mismatch"; // well-formed, but not the one we compute

export interface SignedHeaders {
  /** The timestamp exactly as it was sent: the signature covers its text, not its value. */
  timestamp: string;
  /** The 32 bytes behind the 64 hex digits of the header. */
  signature: Buffer;
}

export type HeaderCheck = { ok: true; headers: SignedHeaders } | { ok: false; problem: SignatureProblem };

// Only decimal digits. Leading zeros are digits, so "0001789985732" is accepted (the contract
// says "decimal digits only" and nothing more). That is harmless: the signature is computed over
// the text as sent, so a different spelling of the same second needs its own valid signature.
// A sign, a space, an exponent or a fraction ("+1", " 1", "1e3", "1.5") is not a digit: refused.
const DIGITS_ONLY = /^[0-9]+$/;

// Exactly this, in lower case. No spaces, no upper-case hex, no other version ("v2=").
const SIGNATURE_HEADER = /^v1=([0-9a-f]{64})$/;

/**
 * Step 1. `nowSeconds` is our clock in whole seconds (the caller rounds it down).
 * The two header values may be missing (`undefined`).
 */
export function checkSignatureHeaders(
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  nowSeconds: number,
): HeaderCheck {
  if (timestampHeader === undefined) return { ok: false, problem: "missing_timestamp" };
  if (!DIGITS_ONLY.test(timestampHeader)) return { ok: false, problem: "bad_timestamp" };
  // A number with hundreds of digits becomes Infinity, which is also "out of range".
  if (Math.abs(Number(timestampHeader) - nowSeconds) > MAX_CLOCK_DIFFERENCE_SECONDS) {
    return { ok: false, problem: "timestamp_out_of_range" };
  }

  if (signatureHeader === undefined) return { ok: false, problem: "missing_signature" };
  const match = SIGNATURE_HEADER.exec(signatureHeader);
  if (match?.[1] === undefined) return { ok: false, problem: "bad_signature_format" };

  return { ok: true, headers: { timestamp: timestampHeader, signature: Buffer.from(match[1], "hex") } };
}

/** Step 2: is the signature of the headers the one we compute with this token for this body? */
export function signatureMatches(token: string, headers: SignedHeaders, body: Buffer): boolean {
  const expected = createHmac("sha256", Buffer.from(token, "utf8"))
    .update(headers.timestamp)
    .update(".")
    .update(body)
    .digest();

  // Constant time: `===` on two strings stops at the first different character, and the time
  // it takes would tell an attacker how many leading characters of a guess are right.
  // Both buffers are 32 bytes (the header format guarantees it); timingSafeEqual throws otherwise.
  return timingSafeEqual(expected, headers.signature);
}
