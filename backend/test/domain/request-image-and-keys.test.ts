import { describe, expect, it } from "vitest";
import { newRequestImageSchema } from "../../src/domain/request-image";
import { isOwnerKey, ownerIdFromKey, ownerKey, requestKey } from "../../src/domain/request-keys";

const image = {
  pk: "USER#user-a",
  sk: "REQ#01J8Z3K5W0ABCDEFGHJKMNPQR1",
  id: "01J8Z3K5W0ABCDEFGHJKMNPQR1",
  partner: "Acme",
  subject: "Order 42",
  body: "Please ship.",
  status: "created",
  createdAt: "2026-09-21T09:00:00.000Z",
};

describe("newRequestImageSchema", () => {
  it("keeps only the request id, the owner and the partner", () => {
    expect(newRequestImageSchema.parse(image)).toEqual({
      requestId: "01J8Z3K5W0ABCDEFGHJKMNPQR1",
      ownerId: "user-a",
      partner: "Acme",
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
    ["partner", { partner: undefined }],
    ["partner", { partner: "" }],
    ["partner", { partner: 42 }],
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
