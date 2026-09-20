import { describe, expect, it } from "vitest";
import { isTerminalStatus } from "./status";

describe("isTerminalStatus", () => {
  it.each([
    ["created", false],
    ["queued", false],
    ["sent", true],
    ["rejected", true],
    ["failed", true],
  ] as const)("%s -> %s", (status, expected) => {
    expect(isTerminalStatus(status)).toBe(expected);
  });
});
