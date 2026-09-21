import { createHmac } from "node:crypto";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { checkSignatureHeaders, signatureMatches } from "../../src/domain/webhook-signature";
import { CONTRACTS } from "../helpers/contracts";
import { sign } from "../helpers/webhook";

// `timingSafeEqual` is wrapped in a spy that still calls the real one. Whether a comparison
// takes the same time whatever the input cannot be seen in a result, so one test looks at
// WHICH function compared the two signatures.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

// The worked example of the contract, read from contracts/fixtures/event/.
const vector = JSON.parse(
  readFileSync(new URL("fixtures/event/signature-vector.json", CONTRACTS), "utf8"),
) as { token: string; timestamp: string; bodyFile: string; signatureHeader: string };
const vectorBody = readFileSync(new URL(`fixtures/event/${vector.bodyFile}`, CONTRACTS)); // the bytes, not text
const NOW = Number(vector.timestamp);

// Both steps in one call, like the service does. Every field can be replaced.
function verify(
  change: { token?: string; timestamp?: string; signature?: string; body?: Buffer; now?: number } = {},
): string {
  const checked = checkSignatureHeaders(
    change.timestamp ?? vector.timestamp,
    change.signature ?? vector.signatureHeader,
    change.now ?? NOW,
  );
  if (!checked.ok) return checked.problem;
  return signatureMatches(change.token ?? vector.token, checked.headers, change.body ?? vectorBody)
    ? "ok"
    : "signature_mismatch";
}

describe("the signature vector of the contract", () => {
  it("is what HMAC-SHA256(token, timestamp + '.' + body) gives, byte for byte", () => {
    const mac = createHmac("sha256", Buffer.from(vector.token, "utf8"))
      .update(Buffer.from(vector.timestamp, "ascii"))
      .update(Buffer.from(".", "ascii"))
      .update(vectorBody);

    expect(`v1=${mac.digest("hex")}`).toBe(vector.signatureHeader);
    expect(sign(vector.token, vector.timestamp, vectorBody)).toBe(vector.signatureHeader);
  });

  it("is accepted", () => {
    expect(verify()).toBe("ok");
  });
});

describe("the signature", () => {
  it.each([
    ["a changed byte in the body", Buffer.from(vectorBody.toString("utf8").replace("Approved", "Declined"))],
    ["a trailing newline in the body", Buffer.concat([vectorBody, Buffer.from("\n")])],
    ["a body with the line endings changed", Buffer.from(vectorBody.toString("utf8").replace(/\n/g, "\r\n"))],
    ["an empty body", Buffer.alloc(0)],
  ])("does not match %s", (_label, body) => {
    expect(verify({ body })).toBe("signature_mismatch");
  });

  it("does not match another token", () => {
    expect(verify({ token: `${vector.token}x` })).toBe("signature_mismatch");
    expect(verify({ token: "" })).toBe("signature_mismatch");
  });

  it("does not match another timestamp, even one that is close to now", () => {
    expect(verify({ timestamp: String(NOW + 1) })).toBe("signature_mismatch");
  });

  it("covers the TEXT of the timestamp: a zero in front is another text, so another signature", () => {
    expect(verify({ timestamp: `0${vector.timestamp}` })).toBe("signature_mismatch");
  });

  it("compares with crypto.timingSafeEqual on two buffers of 32 bytes", () => {
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();

    verify({ token: "another token" });

    expect(spy).toHaveBeenCalledTimes(1);
    const [expected, given] = spy.mock.calls[0] ?? [];
    expect(Buffer.isBuffer(expected) && Buffer.isBuffer(given) && expected.length === 32 && given.length === 32).toBe(true);
  });

  it("is not compared at all when the header is malformed", () => {
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();

    verify({ signature: vector.signatureHeader.toUpperCase() });

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the age of the request", () => {
  const signed = (timestamp: number) => ({ timestamp: String(timestamp), signature: sign(vector.token, String(timestamp), vectorBody) });

  it.each([
    ["300 seconds old", -300, "ok"],
    ["301 seconds old", -301, "timestamp_out_of_range"],
    ["300 seconds in the future", 300, "ok"],
    ["301 seconds in the future", 301, "timestamp_out_of_range"],
    ["the same second", 0, "ok"],
  ])("%s", (_label, offset, want) => {
    expect(verify({ ...signed(NOW + offset), now: NOW })).toBe(want);
  });

  it("looks at our clock, not at the signature: the same request is fresh or stale depending on now", () => {
    expect(verify({ now: NOW + 300 })).toBe("ok");
    expect(verify({ now: NOW + 301 })).toBe("timestamp_out_of_range");
    expect(verify({ now: NOW - 301 })).toBe("timestamp_out_of_range");
  });

  it("treats a number with hundreds of digits as out of range, not as a crash", () => {
    expect(verify({ timestamp: "9".repeat(400) })).toBe("timestamp_out_of_range");
    expect(verify({ timestamp: "0".repeat(400) })).toBe("timestamp_out_of_range");
  });
});

describe("the timestamp header", () => {
  it("is missing", () => {
    expect(checkSignatureHeaders(undefined, vector.signatureHeader, NOW)).toEqual({ ok: false, problem: "missing_timestamp" });
  });

  // "Whole seconds, decimal digits only": nothing but the ASCII digits 0-9 (a sign, a space, an
  // exponent, a fraction, a hex prefix, a full-width digit or a line break is not a digit).
  it.each(["", "+1789985732", "-1789985732", " 1789985732", "1789985732 ", "1789985732\n", "1.789985732e9", "1789985732.0", "1789985732.", "0x6a9f2cc4", "１７８９９８５７３２", "17899 85732", "1789985732,1789985733"])(
    "%j is not decimal digits only",
    (timestamp) => {
      expect(verify({ timestamp })).toBe("bad_timestamp");
    },
  );

  // Decision: leading zeros ARE digits, so they are accepted when the signature covers them
  // (the contract says nothing more than "decimal digits only"; see webhook-signature.ts).
  it("accepts leading zeros, when the signature was made over that very text", () => {
    const timestamp = `000${vector.timestamp}`;

    expect(verify({ timestamp, signature: sign(vector.token, timestamp, vectorBody) })).toBe("ok");
  });
});

describe("the signature header", () => {
  it("is missing", () => {
    expect(checkSignatureHeaders(vector.timestamp, undefined, NOW)).toEqual({ ok: false, problem: "missing_signature" });
  });

  const hex = vector.signatureHeader.slice(3);
  it.each([
    ["empty", ""],
    ["only the version", "v1="],
    ["without the version", hex],
    ["upper-case hex digits", `v1=${hex.toUpperCase()}`],
    ["an upper-case version", `V1=${hex}`],
    ["another version", `v2=${hex}`],
    ["a space in front", ` v1=${hex}`],
    ["a space after the version", `v1= ${hex}`],
    ["a space at the end", `v1=${hex} `],
    ["a line break at the end", `v1=${hex}\n`],
    ["63 hex digits", `v1=${hex.slice(1)}`],
    ["65 hex digits", `v1=${hex}0`],
    ["a character that is not hex", `v1=${hex.slice(0, 63)}g`],
    ["two signatures", `v1=${hex},v1=${hex}`],
  ])("is refused when it is %s", (_label, signature) => {
    expect(verify({ signature })).toBe("bad_signature_format");
  });
});
