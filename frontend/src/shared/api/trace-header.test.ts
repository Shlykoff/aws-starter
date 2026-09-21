import { describe, expect, it } from "vitest";
import { createTraceHeaderValue } from "./trace-header";

const FORMAT = /^Root=1-[0-9a-f]{8}-[0-9a-f]{24};Parent=[0-9a-f]{16};Sampled=1$/;

// 1_700_000_000 s since the epoch is 0x6553f100.
const NOW_MS = 1_700_000_000_123;

describe("createTraceHeaderValue", () => {
  it("builds the X-Ray tracing header from the injected time and random bytes", () => {
    const value = createTraceHeaderValue({
      nowMs: () => NOW_MS,
      // 1, 2, 3, ... so the test also shows that small bytes are padded ("01", not "1").
      randomBytes: (length) => Uint8Array.from({ length }, (_, i) => i + 1),
    });

    expect(value).toBe("Root=1-6553f100-0102030405060708090a0b0c;Parent=0102030405060708;Sampled=1");
  });

  it("pads a small epoch to 8 hex characters", () => {
    const value = createTraceHeaderValue({ nowMs: () => 5_000, randomBytes: (length) => new Uint8Array(length) });

    expect(value).toMatch(/^Root=1-00000005-/);
  });

  it("uses the real clock and crypto by default, and a different value on every call", () => {
    const before = Math.floor(Date.now() / 1000);
    const first = createTraceHeaderValue();
    const second = createTraceHeaderValue();
    const after = Math.floor(Date.now() / 1000);

    expect(first).toMatch(FORMAT);
    expect(second).toMatch(FORMAT);
    expect(first).not.toBe(second);
    const epoch = parseInt(first.slice("Root=1-".length, "Root=1-".length + 8), 16);
    expect(epoch).toBeGreaterThanOrEqual(before);
    expect(epoch).toBeLessThanOrEqual(after);
  });
});
