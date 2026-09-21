import { describe, expect, it } from "vitest";
import { readReplyFacts } from "../../src/domain/reply-facts";
import { expected, fixture } from "../helpers/contracts";

const NS = "urn:aws-starter:reply:v1";
const UUID = "3f2b8c1e-5a4d-4e7b-9c1a-2d6e8f0a1b3c";

describe("readReplyFacts", () => {
  it("reads the values of the valid fixtures", () => {
    expect(readReplyFacts(fixture("reply", "valid/accepted.xml"))).toEqual({
      status: "Accepted",
      messageId: UUID,
      relatesTo: "01M30JDSMHY8CRX59V35WV731S",
      code: undefined,
      description: undefined,
    });
    expect(readReplyFacts(fixture("reply", "valid/rejected-without-relates-to.xml"))).toEqual({
      status: "Rejected",
      messageId: UUID,
      relatesTo: undefined,
      code: "MALFORMED_XML",
      description: "The document is not well-formed XML",
    });
  });

  it("reads every fixture that is valid, whatever its status", () => {
    for (const name of Object.entries(expected.reply).filter(([, want]) => want === "valid").map(([file]) => file)) {
      expect(readReplyFacts(fixture("reply", name))).toBeDefined();
    }
  });

  // The same Reply can be written in many ways. What is read must be what the schema saw.
  describe("the same values whichever way the document is written", () => {
    const body = (status: string) => `<Result><Status>${status}</Status></Result>`;
    const prefixed = `<?xml version="1.0"?><r:Reply xmlns:r="${NS}" version="1"><r:MessageId>${UUID}</r:MessageId><r:ReceivedAt>2026-09-21T10:00:00Z</r:ReceivedAt><r:Result><r:Status>Accepted</r:Status></r:Result></r:Reply>`;

    it("with a namespace prefix instead of the default namespace", () => {
      expect(readReplyFacts(prefixed)).toMatchObject({ status: "Accepted", messageId: UUID });
    });

    it("with comments and processing instructions that look like elements", () => {
      const xml = `<Reply xmlns="${NS}" version="1"><!-- <Status>Accepted</Status> --><?pi <Status>Accepted</Status>?><MessageId>${UUID}</MessageId><ReceivedAt>2026-09-21T10:00:00Z</ReceivedAt><Result><Status>Rejected</Status><Code>SCHEMA_INVALID</Code><Description>why</Description></Result></Reply>`;

      expect(readReplyFacts(xml)).toMatchObject({ status: "Rejected", code: "SCHEMA_INVALID" });
    });

    it("with a comment or CDATA inside a value, and character references", () => {
      const xml = `<Reply xmlns="${NS}" version="1"><MessageId>${UUID}</MessageId><ReceivedAt>2026-09-21T10:00:00Z</ReceivedAt><Result><Status>Rej<!-- x -->ected</Status><Code><![CDATA[SCHEMA_INVALID]]></Code><Description>a &amp; b &lt; c &#65;</Description></Result></Reply>`;

      expect(readReplyFacts(xml)).toMatchObject({ status: "Rejected", code: "SCHEMA_INVALID", description: "a & b < c A" });
    });

    it("with other attribute quoting, whitespace and a redeclared default namespace", () => {
      const xml = `<Reply version='1'   xmlns='${NS}'>\n\n<MessageId>${UUID}</MessageId>\n<ReceivedAt>2026-09-21T10:00:00Z</ReceivedAt>\n${body("Accepted")}\n</Reply>`;

      expect(readReplyFacts(xml)).toMatchObject({ status: "Accepted" });
    });
  });

  describe("returns undefined when the document does not have the shape of a Reply", () => {
    it.each([
      ["not XML", "this is not xml"],
      ["an empty string", ""],
      ["a mismatched tag", "<Reply><a></Reply>"],
      ["another root element", `<Other xmlns="${NS}"/>`],
      ["the right root in another namespace", `<Reply xmlns="urn:other"><Result><Status>Accepted</Status></Result></Reply>`],
      ["no Result", `<Reply xmlns="${NS}"><MessageId>${UUID}</MessageId></Reply>`],
      ["a status that is not one of the two", `<Reply xmlns="${NS}"><MessageId>${UUID}</MessageId><Result><Status>Maybe</Status></Result></Reply>`],
      ["no MessageId", `<Reply xmlns="${NS}"><Result><Status>Accepted</Status></Result></Reply>`],
    ])("%s", (_label, xml) => {
      expect(readReplyFacts(xml)).toBeUndefined();
    });
  });
});
