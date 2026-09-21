import { describe, expect, it } from "vitest";
import type { PartnerAnswer } from "../../src/domain/partner-answer";
import { readAnswer } from "../../src/domain/reply-reader";
import type { ValidationResult } from "../../src/domain/validation-result";
import { createRealValidator, expected, fixture } from "../helpers/contracts";
import { replyXml } from "../helpers/fakes";

// Every row of "How the sender reads the answer" (contracts/partner-api.md), plus the cases
// the contract leaves open. The reader is a pure function, so these are plain tables.
const OURS = "01J8Z3K5W0ABCDEFGHJKMNPQR1";
const OTHER = "01J8Z3K5W0ABCDEFGHJKMNPQR2";
const VALID: ValidationResult = { valid: true };
const INVALID: ValidationResult = { valid: false, findings: [{ element: "Reply", rule: "schema violation" }] };

const accepted = replyXml({ relatesTo: OURS });
const rejected = replyXml({ status: "Rejected", relatesTo: OURS, code: "SCHEMA_INVALID", description: "Name: pattern" });

const answer = (httpStatus: number, body: string | undefined, bodyProblem?: "too_large" | "unreadable"): PartnerAnswer => ({
  kind: "answer",
  httpStatus,
  body,
  ...(bodyProblem && { bodyProblem }),
});
// `validation` is what the validator said about the body; a body that is valid unless a test says otherwise.
const read = (given: PartnerAnswer, validation: ValidationResult = VALID) => readAnswer(given, validation, OURS);
const decisionOf = (given: PartnerAnswer, validation: ValidationResult = VALID) => {
  const reading = read(given, validation);
  return [reading.decision, reading.reason];
};

describe("the table of the contract", () => {
  it("200 + Accepted: delivered", () => {
    expect(decisionOf(answer(200, accepted))).toEqual(["delivered", "accepted"]);
  });

  it.each([400, 422])("%i + Rejected: refused for good", (status) => {
    expect(decisionOf(answer(status, rejected))).toEqual(["refused", "rejected"]);
  });

  it.each([401, 403, 408, 429, 500, 502, 503, 504, 599])("%i: retry (temporary, or our own configuration)", (status) => {
    expect(decisionOf(answer(status, undefined))).toEqual(["retry", `http_${status}`]);
  });

  it.each([404, 405, 409, 410, 413, 415, 418, 451])("%i, any other 4xx: refused, our request is wrong", (status) => {
    expect(decisionOf(answer(status, undefined))).toEqual(["refused", `http_${status}`]);
  });

  it.each(["timeout", "network_error"] as const)("no answer (%s): retry", (reason) => {
    const reading = read({ kind: "no-answer", reason });

    expect(reading).toEqual({ decision: "retry", reason, reply: null, facts: undefined });
  });
});

describe("a 200 that is not a valid Reply is a protocol violation: retry", () => {
  it("without a body", () => {
    expect(decisionOf(answer(200, undefined))).toEqual(["retry", "reply_missing"]);
  });

  it("with a body above the limit (the client did not read it)", () => {
    expect(decisionOf(answer(200, undefined, "too_large"))).toEqual(["retry", "reply_too_large"]);
  });

  it("with a body that could not be read", () => {
    expect(decisionOf(answer(200, undefined, "unreadable"))).toEqual(["retry", "reply_unreadable"]);
  });

  it("with a body that violates reply.xsd (or has a DOCTYPE, or is not XML: the validator says invalid)", () => {
    expect(decisionOf(answer(200, "<html>oops</html>"), INVALID)).toEqual(["retry", "reply_invalid"]);
  });

  it("with a body nobody validated (a bug of the caller must not look like a valid Reply)", () => {
    expect(readAnswer(answer(200, accepted), undefined, OURS)).toMatchObject({ decision: "retry", reason: "reply_invalid" });
  });

  it.each([
    ["Accepted with a Code", replyXml({ relatesTo: OURS, code: "SCHEMA_INVALID" })],
    ["Accepted with a Description", replyXml({ relatesTo: OURS, description: "all fine" })],
    ["Rejected without a Code", replyXml({ status: "Rejected", relatesTo: OURS, description: "no code" })],
    ["Rejected without a Description", replyXml({ status: "Rejected", relatesTo: OURS, code: "SCHEMA_INVALID" })],
    ["Rejected without both", replyXml({ status: "Rejected", relatesTo: OURS })],
  ])("with a Reply that breaks the rule about Code and Description: %s", (_label, body) => {
    expect(decisionOf(answer(200, body))).toEqual(["retry", "reply_rule_violation"]);
  });
});

describe("what the contract does not say (the cautious reading: never a silent sent or rejected)", () => {
  it("200 + Rejected: the status and the reply disagree, retry", () => {
    expect(decisionOf(answer(200, rejected))).toEqual(["retry", "status_and_reply_disagree"]);
  });

  it.each([400, 422])("%i + Accepted: the status and the reply disagree, retry", (status) => {
    expect(decisionOf(answer(status, accepted))).toEqual(["retry", "status_and_reply_disagree"]);
  });

  it("a Reply that names another submission is not an answer to ours, retry", () => {
    expect(decisionOf(answer(200, replyXml({ relatesTo: OTHER })))).toEqual(["retry", "reply_relates_to_mismatch"]);
    expect(
      decisionOf(answer(422, replyXml({ status: "Rejected", relatesTo: OTHER, code: "SCHEMA_INVALID", description: "x" }))),
    ).toEqual(["retry", "reply_relates_to_mismatch"]);
  });

  it("an absent RelatesTo is allowed by reply.xsd, so it does not stop a delivery", () => {
    expect(decisionOf(answer(200, replyXml()))).toEqual(["delivered", "accepted"]);
  });

  it.each([400, 422, 404])("a %i whose body is missing or not a valid Reply is still a refusal: the status decides", (status) => {
    expect(decisionOf(answer(status, undefined))).toEqual(["refused", `http_${status}`]);
    expect(decisionOf(answer(status, "<nope/>"), INVALID)).toEqual(["refused", `http_${status}`]);
    expect(decisionOf(answer(status, undefined, "too_large"))).toEqual(["refused", `http_${status}`]);
  });

  it("a 503 whose body is a fine Accepted Reply is still a retry: the body of an error status is only recorded", () => {
    expect(decisionOf(answer(503, accepted))).toEqual(["retry", "http_503"]);
  });

  it.each([100, 201, 202, 204, 301, 302, 303, 307, 308, 304])(
    "%i is not defined by the contract and is never proof of delivery: retry",
    (status) => {
      expect(decisionOf(answer(status, undefined))).toEqual(["retry", "unexpected_status"]);
    },
  );
});

describe("what is recorded about the reply", () => {
  it("the status, the body as received, whether it was valid, and the values read from it", () => {
    const reading = read(answer(422, rejected));

    expect(reading.reply).toEqual({
      httpStatus: 422,
      xml: rejected,
      valid: true,
      status: "Rejected",
      code: "SCHEMA_INVALID",
      description: "Name: pattern",
    });
    expect(reading.facts).toMatchObject({
      status: "Rejected",
      code: "SCHEMA_INVALID",
      messageId: "3f2b8c1e-5a4d-4e7b-9c1a-2d6e8f0a1b3c",
      relatesTo: OURS,
    });
  });

  it("an Accepted reply has no code and no description", () => {
    const { reply } = read(answer(200, accepted));

    expect(reply).toMatchObject({ httpStatus: 200, valid: true, status: "Accepted" });
    expect(reply).not.toHaveProperty("code", expect.anything());
  });

  it("a reply without a body: xml null, not valid", () => {
    expect(read(answer(503, undefined)).reply).toEqual({ httpStatus: 503, xml: null, valid: false });
  });

  it("a body that broke the rule is kept and marked not valid, with what could be read from it", () => {
    const body = replyXml({ relatesTo: OURS, code: "SCHEMA_INVALID" });

    expect(read(answer(200, body)).reply).toMatchObject({ xml: body, valid: false, status: "Accepted", code: "SCHEMA_INVALID" });
  });

  it("a body that failed the schema is kept as received, and nothing is read from it", () => {
    expect(read(answer(200, "<html>oops</html>"), INVALID).reply).toEqual({
      httpStatus: 200,
      xml: "<html>oops</html>",
      valid: false,
    });
  });
});

describe("the reply fixtures of contracts/fixtures, through the real validator and the reader", () => {
  const validator = createRealValidator();
  // The fixtures answer the submission with this id.
  const FIXTURE_ID = "01M30JDSMHY8CRX59V35WV731S";
  const readFixture = async (name: string, httpStatus: number) => {
    const body = fixture("reply", name);
    return readAnswer(answer(httpStatus, body), await validator.validateReply(body), FIXTURE_ID);
  };

  it.each(Object.entries(expected.reply))("%s (%s) is read the way the contract says", async (name, want) => {
    const isRejected = name.includes("rejected");

    if (want === "valid") {
      // A valid reply with the status code that matches its status.
      const ok = await readFixture(name, isRejected ? 422 : 200);
      expect(ok.reply?.valid).toBe(true);
      expect(ok.decision).toBe(isRejected ? "refused" : "delivered");
    } else {
      // A reply that violates reply.xsd: a 200 is a protocol violation, a 422 is still a refusal.
      const onOk = await readFixture(name, 200);
      expect(onOk).toMatchObject({ decision: "retry", reason: "reply_invalid" });
      expect(onOk.reply?.valid).toBe(false);
      const onRefusal = await readFixture(name, 422);
      expect(onRefusal).toMatchObject({ decision: "refused", reason: "http_422" });
    }
  });
});
