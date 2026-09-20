import { describe, expect, it } from "vitest";
import { createRequestSchema } from "../../src/domain/create-request";

const valid = { partner: "Acme Partner", subject: "Order 42", body: "Please ship." };

describe("createRequestSchema", () => {
  it("accepts a valid body", () => {
    expect(createRequestSchema.parse(valid)).toEqual(valid);
  });

  it("trims surrounding whitespace", () => {
    const parsed = createRequestSchema.parse({
      partner: "  Acme  ",
      subject: "\tOrder 42\n",
      body: " text ",
    });
    expect(parsed).toEqual({ partner: "Acme", subject: "Order 42", body: "text" });
  });

  it.each(["partner", "subject", "body"] as const)("rejects an empty %s", (field) => {
    expect(createRequestSchema.safeParse({ ...valid, [field]: "" }).success).toBe(false);
  });

  it.each(["partner", "subject", "body"] as const)(
    "rejects a %s that is only whitespace (trim happens before the length check)",
    (field) => {
      expect(createRequestSchema.safeParse({ ...valid, [field]: "   " }).success).toBe(false);
    },
  );

  it.each([
    ["partner", 100],
    ["subject", 200],
    ["body", 5000],
  ] as const)("accepts %s at its maximum of %i characters and rejects one more", (field, max) => {
    expect(createRequestSchema.safeParse({ ...valid, [field]: "x".repeat(max) }).success).toBe(true);
    expect(createRequestSchema.safeParse({ ...valid, [field]: "x".repeat(max + 1) }).success).toBe(false);
  });

  it.each(["partner", "subject", "body"] as const)("rejects a missing %s", (field) => {
    const withoutField: Partial<typeof valid> = { ...valid };
    delete withoutField[field];
    expect(createRequestSchema.safeParse(withoutField).success).toBe(false);
  });

  it("rejects values that are not strings", () => {
    expect(createRequestSchema.safeParse({ ...valid, partner: 42 }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...valid, body: null }).success).toBe(false);
  });

  it.each(["owner", "status", "id", "pk"])("rejects the unknown key %s", (key) => {
    expect(createRequestSchema.safeParse({ ...valid, [key]: "anything" }).success).toBe(false);
  });

  it("rejects bodies that are not objects", () => {
    expect(createRequestSchema.safeParse(null).success).toBe(false);
    expect(createRequestSchema.safeParse([valid]).success).toBe(false);
    expect(createRequestSchema.safeParse("text").success).toBe(false);
  });
});
