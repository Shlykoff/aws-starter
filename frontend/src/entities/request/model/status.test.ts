import { describe, expect, it } from "vitest";
import { makeClientDecision, makeRequest } from "@test/factories";
import { isAwaitingDecision, isTerminalStatus } from "./status";

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

describe("isAwaitingDecision", () => {
  it("is true only for a delivered request without a decision", () => {
    expect(isAwaitingDecision(makeRequest({ status: "sent" }))).toBe(true);
  });

  it.each(["created", "queued", "failed", "rejected"] as const)("is false for a %s request without a decision", (status) => {
    expect(isAwaitingDecision(makeRequest({ status }))).toBe(false);
  });

  it("is false once the client has decided, whatever they decided", () => {
    expect(isAwaitingDecision(makeRequest({ status: "sent", clientDecision: makeClientDecision() }))).toBe(false);
    expect(
      isAwaitingDecision(makeRequest({ status: "sent", clientDecision: makeClientDecision({ decision: "Declined" }) })),
    ).toBe(false);
  });
});
