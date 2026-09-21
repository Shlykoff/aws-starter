import { describe, expect, it } from "vitest";
import { makeClientDecision, makeRequest } from "@test/factories";
import { getClientStatus, isAwaitingDecision, isTerminalStatus } from "./status";

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

describe("getClientStatus", () => {
  it("is Waiting for a delivered request without a decision", () => {
    expect(getClientStatus(makeRequest({ status: "sent" }))).toBe("Waiting");
  });

  it.each(["created", "queued", "failed", "rejected"] as const)("is nothing for a %s request without a decision", (status) => {
    expect(getClientStatus(makeRequest({ status }))).toBeUndefined();
  });

  it.each(["Approved", "Declined"] as const)("is the decision itself once the client said %s", (decision) => {
    const clientDecision = makeClientDecision({ decision });

    expect(getClientStatus(makeRequest({ status: "sent", clientDecision }))).toBe(decision);
  });

  // The webhook accepts a decision for any request, so it is shown whatever the delivery status is.
  it.each(["created", "queued", "sent", "failed", "rejected"] as const)("shows a decision on a %s request", (status) => {
    expect(getClientStatus(makeRequest({ status, clientDecision: makeClientDecision({ decision: "Declined" }) }))).toBe(
      "Declined",
    );
  });
});
