import { describe, expect, it } from "vitest";
import { makeClientDecision, makeRequest } from "@test/factories";
import { partnerRequestSchema } from "./types";

// The wire format of docs/api.md: the API omits `clientDecision` (and `reason`) when there is
// none, and never sends null. Every "rejects" case below is a state the page shows as an error.
describe("partnerRequestSchema: clientDecision", () => {
  it("accepts a request the client has not answered: the field is simply absent", () => {
    const parsed = partnerRequestSchema.parse(makeRequest());

    expect("clientDecision" in parsed).toBe(false);
  });

  it("accepts an approval with a reason and keeps every field", () => {
    const decision = makeClientDecision({ decision: "Approved", reason: "Paid by card." });

    const parsed = partnerRequestSchema.parse(makeRequest({ status: "sent", clientDecision: decision }));

    expect(parsed.clientDecision).toEqual(decision);
  });

  it("accepts a decline without a reason", () => {
    const decision = makeClientDecision({ decision: "Declined" });

    const parsed = partnerRequestSchema.parse(makeRequest({ clientDecision: decision }));

    expect(parsed.clientDecision).toEqual(decision);
    expect(parsed.clientDecision).not.toHaveProperty("reason");
  });

  it.each(["failed", "rejected", "queued"] as const)("accepts a decision on a %s request", (status) => {
    const request = makeRequest({ status, clientDecision: makeClientDecision() });

    expect(partnerRequestSchema.parse(request).clientDecision).toBeDefined();
  });

  it.each([
    ["an unknown decision", { decision: "Maybe" }],
    ["a decision in another case", { decision: "approved" }],
    ["a missing decision", { decision: undefined }],
    ["a null reason (it is omitted, never null)", { reason: null }],
    ["a reason that is not text", { reason: 42 }],
    ["a missing `at`", { at: undefined }],
    ["a missing `receivedAt`", { receivedAt: undefined }],
  ])("rejects %s", (_name, broken) => {
    const request = { ...makeRequest({ status: "sent" }), clientDecision: { ...makeClientDecision(), ...broken } };

    expect(partnerRequestSchema.safeParse(request).success).toBe(false);
  });

  it("rejects a null clientDecision (it is omitted, never null)", () => {
    const request = { ...makeRequest({ status: "sent" }), clientDecision: null };

    expect(partnerRequestSchema.safeParse(request).success).toBe(false);
  });

  it("drops fields it does not know instead of failing, like the rest of the request", () => {
    const request = {
      ...makeRequest({ status: "sent" }),
      owner: "user-1",
      clientDecision: { ...makeClientDecision({ reason: "Fine." }), decisionAtMs: 1738593000000 },
    };

    const parsed = partnerRequestSchema.parse(request);

    expect(parsed).not.toHaveProperty("owner");
    expect(parsed.clientDecision).not.toHaveProperty("decisionAtMs");
    expect(parsed.clientDecision?.reason).toBe("Fine.");
  });
});
