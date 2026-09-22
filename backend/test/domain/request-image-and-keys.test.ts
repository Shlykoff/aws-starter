import { describe, expect, it } from "vitest";
import { newRequestImageSchema } from "../../src/domain/request-image";
import { isOwnerKey, ownerIdFromKey, ownerKey, requestKey } from "../../src/domain/request-keys";

const image = {
  pk: "USER#user-a",
  sk: "REQ#01J8Z3K5W0ABCDEFGHJKMNPQR1",
  id: "01J8Z3K5W0ABCDEFGHJKMNPQR1",
  subject: "Order 42",
  body: "Please ship.",
  senderEmail: "sender@example.test",
  status: "created",
  createdAt: "2026-09-21T09:00:00.000Z",
};

describe("newRequestImageSchema", () => {
  it("keeps only the request id, the owner and the retry count (0 for a new request)", () => {
    expect(newRequestImageSchema.parse(image)).toEqual({
      requestId: "01J8Z3K5W0ABCDEFGHJKMNPQR1",
      ownerId: "user-a",
      retryCount: 0,
    });
  });

  it("reads the retry count of a request that was sent again", () => {
    expect(newRequestImageSchema.parse({ ...image, retryCount: 3 }).retryCount).toBe(3);
  });

  it("ignores the client's decision (clientDecision, decisionAtMs), like every other attribute it does not need", () => {
    const withDecision = {
      ...image,
      decisionAtMs: 1789985732000,
      clientDecision: { decision: "Approved", at: "2026-09-21T10:15:32.000Z", receivedAt: "2026-09-21T10:15:40.000Z", eventId: "x" },
    };

    expect(newRequestImageSchema.parse(withDecision)).toEqual({
      requestId: "01J8Z3K5W0ABCDEFGHJKMNPQR1",
      ownerId: "user-a",
      retryCount: 0,
    });
  });

  it("passes on the traceparent of the request when the image has one", () => {
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    expect(newRequestImageSchema.parse({ ...image, traceparent }).traceparent).toBe(traceparent);
    expect(newRequestImageSchema.parse(image)).not.toHaveProperty("traceparent");
  });

  // A trace is a help, not a condition: whatever is stored in the attribute, the request is read.
  it.each([
    ["not a string", 42],
    ["null", null],
    ["a map", { S: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" }],
    ["far too long", "0".repeat(10_000)],
  ])("drops a traceparent that is %s, and still reads the request", (_name, traceparent) => {
    const parsed = newRequestImageSchema.safeParse({ ...image, traceparent });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      requestId: "01J8Z3K5W0ABCDEFGHJKMNPQR1",
      ownerId: "user-a",
      retryCount: 0,
    });
  });

  it("reads an owner id that itself contains a # or a dash", () => {
    const parsed = newRequestImageSchema.parse({ ...image, pk: "USER#us#er-1" });

    expect(parsed.ownerId).toBe("us#er-1");
  });

  it.each([
    ["pk", { pk: undefined }],
    ["pk", { pk: "OWNER#user-a" }],
    ["pk", { pk: "USER#" }],
    ["id", { id: undefined }],
    ["id", { id: "" }],
    ["retryCount", { retryCount: -1 }],
    ["retryCount", { retryCount: 1.5 }],
    ["retryCount", { retryCount: "1" }],
  ])("rejects an image with a bad %s", (field, change) => {
    const result = newRequestImageSchema.safeParse({ ...image, ...change });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual([field]);
  });
});

describe("request keys", () => {
  it("builds and reads back the owner key", () => {
    expect(ownerKey("user-a")).toBe("USER#user-a");
    expect(ownerIdFromKey(ownerKey("user-a"))).toBe("user-a");
    expect(isOwnerKey("USER#user-a")).toBe(true);
    expect(isOwnerKey("USER#")).toBe(false);
    expect(isOwnerKey("REQ#x")).toBe(false);
  });

  it("builds the sort key", () => {
    expect(requestKey("01J8Z3K5W0ABCDEFGHJKMNPQR1")).toBe("REQ#01J8Z3K5W0ABCDEFGHJKMNPQR1");
  });
});
