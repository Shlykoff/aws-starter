import { describe, expect, it } from "vitest";
import {
  MESSAGE_GROUP_ID,
  decodeDeliveryMessage,
  deduplicationId,
  encodeDeliveryMessage,
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

describe("MESSAGE_GROUP_ID", () => {
  it("is a fixed literal: one recipient, one group", () => {
    expect(MESSAGE_GROUP_ID).toBe("requests");
  });

  it("only uses characters a FIFO group id allows", () => {
    expect(MESSAGE_GROUP_ID).toMatch(/^[A-Za-z0-9!"#$%&'()*+,\-./:;=?@_]{1,128}$/);
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
