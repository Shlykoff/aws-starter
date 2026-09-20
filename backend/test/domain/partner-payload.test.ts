import { describe, expect, it } from "vitest";
import { toPartnerPayload } from "../../src/domain/partner-payload";

describe("toPartnerPayload", () => {
  it("copies the five fields of the contract and drops the status", () => {
    const payload = toPartnerPayload({
      id: "01J8Z3K5W0ABCDEFGHJKMNPQR1",
      partner: "Acme",
      subject: "Order 42",
      body: "Please ship.",
      status: "queued",
      createdAt: "2026-09-21T09:00:00.000Z",
    });

    expect(payload).toEqual({
      id: "01J8Z3K5W0ABCDEFGHJKMNPQR1",
      partner: "Acme",
      subject: "Order 42",
      body: "Please ship.",
      createdAt: "2026-09-21T09:00:00.000Z",
    });
  });
});
