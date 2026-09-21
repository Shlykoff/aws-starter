import { describe, expect, it } from "vitest";
import {
  decodeDeliveryMessage,
  deduplicationId,
  encodeDeliveryMessage,
  messageGroupId,
} from "../../src/domain/delivery-message";

describe("deduplicationId", () => {
  const ID = "01J8Z3K5W0ABCDEFGHJKMNPQR1";

  it("is the request id for the first send", () => {
    expect(deduplicationId(ID, 0)).toBe(ID);
  });

  it("is <requestId>-r<retryCount> for a send after a retry, and differs between retries", () => {
    expect(deduplicationId(ID, 1)).toBe(`${ID}-r1`);
    expect(deduplicationId(ID, 2)).toBe(`${ID}-r2`);
  });

  it("only uses characters a FIFO deduplication id allows and stays short", () => {
    expect(deduplicationId(ID, 123456)).toMatch(/^[A-Za-z0-9-]{1,128}$/);
  });
});

describe("messageGroupId", () => {
  // Reference values computed outside the code: printf 'acme' | shasum -a 256
  it("is the SHA-256 hex digest of the trimmed, lower-cased partner", () => {
    expect(messageGroupId("acme")).toBe(
      "822b33ad87c148a0a20a5ba7cd5ebcaa68d36a18e7aad165554903f52ca82757",
    );
    expect(messageGroupId("globex")).toBe(
      "5bc1a08d28e40fe79ca3ecb077b3bd14ff00df9bad0c4a0d74ecd0805ecf0b1f",
    );
  });

  it("gives one group to the spellings of the same partner", () => {
    const expected = messageGroupId("acme");
    expect(messageGroupId("Acme")).toBe(expected);
    expect(messageGroupId("  ACME\n")).toBe(expected);
  });

  it("gives different partners different groups", () => {
    expect(messageGroupId("acme")).not.toBe(messageGroupId("globex"));
  });

  it("only uses characters a FIFO group id allows, however odd the partner is", () => {
    const group = messageGroupId("Ünïcode & spaces / [brackets] 😀");
    expect(group).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("delivery message", () => {
  const message = { requestId: "01J8Z3K5W0ABCDEFGHJKMNPQR1", ownerId: "user-a" };

  it("is written as JSON with the two ids and nothing else", () => {
    const withExtras = { ...message, subject: "Order 42", body: "Please ship." };

    expect(JSON.parse(encodeDeliveryMessage(withExtras)) as unknown).toEqual(message);
  });

  it("decodes what was encoded", () => {
    expect(decodeDeliveryMessage(encodeDeliveryMessage(message))).toEqual(message);
  });

  it.each([
    ["not JSON", "{oops"],
    ["a JSON string", '"hello"'],
    ["a missing ownerId", '{"requestId":"01J8Z3K5W0ABCDEFGHJKMNPQR1"}'],
    ["a missing requestId", '{"ownerId":"user-a"}'],
    ["an empty id", '{"requestId":"","ownerId":"user-a"}'],
    ["a number instead of an id", '{"requestId":42,"ownerId":"user-a"}'],
  ])("does not decode %s", (_label, body) => {
    expect(decodeDeliveryMessage(body)).toBeUndefined();
  });
});
