import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KNOWN_ELEMENTS } from "../../src/clients/xsd-findings";
import type { Problem } from "../../src/domain/exchange";
import { isUnreadableDocument } from "../../src/domain/validation-result";
import { XSD_DIRECTORY, createRealValidator, expected, fixture, fixturesOnDisk } from "../helpers/contracts";
import type { FixtureKind } from "../helpers/contracts";

// The REAL validator: libxml2 as WebAssembly (xmllint-wasm) and the real files of
// contracts/xsd/. Each validation starts a worker thread, so a test takes tens of ms.
const validator = createRealValidator();
const validate = (kind: FixtureKind, xml: string) =>
  kind === "submission"
    ? validator.validateSubmission(xml)
    : kind === "reply"
      ? validator.validateReply(xml)
      : validator.validateEvent(xml);

const NOT_WELL_FORMED: Problem = { element: "(document)", rule: "not well-formed XML" };
const DOCTYPE: Problem = { element: "(document)", rule: "DOCTYPE not allowed" };

// What the validator says about each invalid fixture, written out by hand. These are the
// real messages of libxml2 turned into "element + rule": the mapping of
// src/clients/xsd-findings.ts, pinned down one fixture at a time.
const FINDINGS: Record<FixtureKind, Record<string, Problem[]>> = {
  submission: {
    "invalid/doctype-entity-expansion.xml": [DOCTYPE],
    "invalid/doctype-external-entity.xml": [DOCTYPE],
    "invalid/message-id-bad-character.xml": [{ element: "MessageId", rule: "does not match the allowed pattern" }],
    "invalid/message-id-lowercase.xml": [{ element: "MessageId", rule: "does not match the allowed pattern" }],
    "invalid/missing-content.xml": [{ element: "Submission", rule: "missing child element" }],
    "invalid/missing-version.xml": [{ element: "Submission", rule: "missing attribute" }],
    "invalid/not-well-formed.xml": [NOT_WELL_FORMED],
    "invalid/not-xml.xml": [NOT_WELL_FORMED],
    "invalid/recipient-pattern.xml": [{ element: "Name", rule: "does not match the allowed pattern" }],
    "invalid/recipient-too-long.xml": [{ element: "Name", rule: "too long" }],
    "invalid/sent-at-not-a-date.xml": [{ element: "SentAt", rule: "not a valid value of its type" }],
    "invalid/subject-empty.xml": [{ element: "Subject", rule: "too short" }],
    "invalid/subject-too-long.xml": [{ element: "Subject", rule: "too long" }],
    "invalid/unknown-element.xml": [{ element: "(unknown)", rule: "unexpected element" }],
    "invalid/wrong-element-order.xml": [{ element: "Content", rule: "unexpected element" }],
    "invalid/wrong-namespace.xml": [{ element: "Submission", rule: "unexpected root element" }],
    "invalid/wrong-version.xml": [{ element: "Submission", rule: "attribute value not allowed" }],
  },
  reply: {
    "invalid/bad-code.xml": [{ element: "Code", rule: "value not allowed" }],
    "invalid/bad-status.xml": [{ element: "Status", rule: "value not allowed" }],
    "invalid/description-too-long.xml": [{ element: "Description", rule: "too long" }],
    "invalid/missing-result.xml": [{ element: "Reply", rule: "missing child element" }],
    "invalid/uppercase-uuid.xml": [{ element: "MessageId", rule: "does not match the allowed pattern" }],
  },
  event: {
    "invalid/decision-lowercase.xml": [{ element: "Decision", rule: "value not allowed" }],
    "invalid/decision-unknown.xml": [{ element: "Decision", rule: "value not allowed" }],
    "invalid/doctype-entity-expansion.xml": [DOCTYPE],
    "invalid/doctype-external-entity.xml": [DOCTYPE],
    "invalid/event-id-uppercase.xml": [{ element: "EventId", rule: "does not match the allowed pattern" }],
    "invalid/missing-decision.xml": [{ element: "DecisionEvent", rule: "missing child element" }],
    "invalid/missing-event-id.xml": [{ element: "OccurredAt", rule: "unexpected element" }],
    "invalid/not-well-formed.xml": [NOT_WELL_FORMED],
    "invalid/not-xml.xml": [NOT_WELL_FORMED],
    "invalid/occurred-at-no-time-zone.xml": [{ element: "OccurredAt", rule: "does not match the allowed pattern" }],
    "invalid/occurred-at-not-a-date.xml": [{ element: "OccurredAt", rule: "not a valid value of its type" }],
    "invalid/reason-empty.xml": [{ element: "Reason", rule: "too short" }],
    "invalid/reason-too-long.xml": [{ element: "Reason", rule: "too long" }],
    "invalid/relates-to-not-a-ulid.xml": [{ element: "RelatesTo", rule: "does not match the allowed pattern" }],
    "invalid/unknown-element.xml": [{ element: "(unknown)", rule: "unexpected element" }],
    "invalid/wrong-element-order.xml": [{ element: "RelatesTo", rule: "unexpected element" }],
    "invalid/wrong-namespace.xml": [{ element: "DecisionEvent", rule: "unexpected root element" }],
    "invalid/wrong-version.xml": [{ element: "DecisionEvent", rule: "attribute value not allowed" }],
  },
};

describe("the contract fixtures (contracts/fixtures/expected.json)", () => {
  it.each(["submission", "reply", "event"] as const)("lists every %s fixture that is on disk, and only those", (kind) => {
    expect(Object.keys(expected[kind]).sort()).toEqual(fixturesOnDisk(kind));
  });

  // "SCHEMA_INVALID" and "MALFORMED_XML" are the two ways for the RECIPIENT to say no (a 422
  // and a 400). For the sender both are the same thing: the document is not valid.
  describe.each(["submission", "reply", "event"] as const)("%s", (kind) => {
    it.each(Object.entries(expected[kind]))("%s must be %s", async (name, want) => {
      const result = await validate(kind, fixture(kind, name));

      expect(result.valid).toBe(want === "valid");
    });
  });

  it.each(Object.entries(FINDINGS).flatMap(([kind, byName]) => Object.entries(byName).map(([name, findings]) => [kind as FixtureKind, name, findings] as const)))(
    "%s/%s: names the element and the rule, nothing else",
    async (kind, name, findings) => {
      const result = await validate(kind, fixture(kind, name));

      expect(result).toEqual({ valid: false, findings });
    },
  );

  it("has a table of findings for every invalid fixture", () => {
    for (const kind of ["submission", "reply", "event"] as const) {
      const invalid = Object.keys(expected[kind]).filter((name) => expected[kind][name] !== "valid");
      expect(Object.keys(FINDINGS[kind]).sort()).toEqual(invalid.sort());
    }
  });

  // The webhook answers 422 for SCHEMA_INVALID and 400 for MALFORMED_XML (which covers a DOCTYPE).
  // It tells them apart by the findings, so the split is checked against every event fixture.
  it.each(Object.entries(expected.event).filter(([, want]) => want !== "valid"))(
    "event %s is told apart as %s (422 or 400)",
    async (name, want) => {
      const result = await validator.validateEvent(fixture("event", name));

      if (result.valid) throw new Error("expected a problem");
      expect(isUnreadableDocument(result)).toBe(want === "MALFORMED_XML");
    },
  );

  it("refuses the malformed submissions the way the recipient does: as not well-formed, without crashing", async () => {
    const malformed = Object.entries(expected.submission).filter(([, want]) => want === "MALFORMED_XML");

    expect(malformed.length).toBeGreaterThan(0);
    for (const [name] of malformed) {
      const result = await validator.validateSubmission(fixture("submission", name));
      expect(result.valid).toBe(false);
    }
  });
});

describe("findings never hold a value of the document", () => {
  const CANARY = "CANARY-9f3a7c";
  const submission = (overrides: { name?: string; messageId?: string; sentAt?: string; version?: string; subject?: string; extra?: string; root?: string; attribute?: string }) => `<?xml version="1.0" encoding="UTF-8"?>
<${overrides.root ?? "Submission"} xmlns="urn:aws-starter:submission:v1" version="${overrides.version ?? "1"}"${overrides.attribute ?? ""}>
  <Header>
    <MessageId>${overrides.messageId ?? "01M30JDSMHY8CRX59V35WV731S"}</MessageId>
    <SentAt>${overrides.sentAt ?? "2026-09-20T23:29:07.123Z"}</SentAt>
    <Sender><Name>aws-starter</Name></Sender>
    <Recipient><Name>${overrides.name ?? "Partner OK"}</Name></Recipient>
  </Header>
  <Content>
    <Subject>${overrides.subject ?? "Delivery schedule"}</Subject>
    <Text>text</Text>${overrides.extra ?? ""}
  </Content>
</${overrides.root ?? "Submission"}>`;

  // Every one of these puts the canary into a place where libxml2 quotes it in its message,
  // or where it appears in the document next to the error.
  const documents: [string, string][] = [
    ["a value that breaks a pattern", submission({ name: `${CANARY} #` })],
    ["a message id that breaks the pattern", submission({ messageId: CANARY })],
    ["a date that is not a date", submission({ sentAt: CANARY })],
    ["a version that is not allowed", submission({ version: CANARY })],
    ["an element nobody knows", submission({ extra: `<${CANARY}>x</${CANARY}>` })],
    ["an attribute nobody knows", submission({ attribute: ` ${CANARY}="x"` })],
    ["a root element nobody knows", submission({ root: CANARY })],
    ["text where only elements may be", submission({ extra: CANARY })],
    ["a value with a line break, to split the message into lines", submission({ name: `${CANARY}\nElement 'Subject': [facet 'minLength'] ${CANARY}\n#` })],
    ["a value that imitates another message", submission({ name: `${CANARY}' is not a valid value of the atomic type 'xs:dateTime #` })],
    ["a document that is not well-formed", `${CANARY} <a><b></a>`],
    ["not XML at all", CANARY],
  ];

  it.each(documents)("%s", async (_label, xml) => {
    const result = await validator.validateSubmission(xml);

    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("puts only names from the schemas and fixed phrases into the findings", async () => {
    const allowedRules = new Set([
      "too short", "too long", "does not match the allowed pattern", "value not allowed",
      "not a valid value of its type", "missing child element", "unexpected element",
      "missing attribute", "unexpected attribute", "unexpected root element", "text not allowed here",
      "unexpected child element", "schema violation", "not well-formed XML",
      "attribute value not allowed", "attribute does not match the allowed pattern",
    ]);
    for (const [, xml] of documents) {
      const result = await validator.validateSubmission(xml);
      if (result.valid) throw new Error("expected a problem");
      for (const { element, rule } of result.findings) {
        expect([...KNOWN_ELEMENTS, "(document)", "(unknown)"]).toContain(element);
        expect([...allowedRules]).toContain(rule);
      }
    }
  });

  it("does not put a name that somebody else chose into the findings", async () => {
    const result = await validator.validateSubmission(
      submission({ extra: `<${CANARY}>x</${CANARY}>`, root: "Submission" }),
    );

    expect(result).toEqual({ valid: false, findings: [{ element: "(unknown)", rule: "unexpected element" }] });
  });
});

describe("findings of an event never hold a value of the document", () => {
  const CANARY = "CANARY-9f3a7c";
  const eventWith = (change: (xml: string) => string) => change(fixture("event", "valid/declined-with-reason.xml"));
  const documents: [string, string][] = [
    ["a decision that is not one of the two", eventWith((xml) => xml.replace("Declined", CANARY))],
    ["an event id that breaks the pattern", eventWith((xml) => xml.replace(/<EventId>.*<\/EventId>/, `<EventId>${CANARY}</EventId>`))],
    ["a date that is not a date", eventWith((xml) => xml.replace(/<OccurredAt>.*<\/OccurredAt>/, `<OccurredAt>${CANARY}</OccurredAt>`))],
    ["a reason that is too long", eventWith((xml) => xml.replace("Out of stock", `${CANARY}${"x".repeat(500)}`))],
    ["a version that is not allowed", eventWith((xml) => xml.replace('version="1"', `version="${CANARY}"`))],
    ["an element nobody knows", eventWith((xml) => xml.replace("</DecisionEvent>", `<${CANARY}>x</${CANARY}></DecisionEvent>`))],
    ["a root element nobody knows", eventWith((xml) => xml.replaceAll("DecisionEvent", CANARY))],
    ["a document that is not well-formed", `${CANARY} <a><b></a>`],
  ];

  it.each(documents)("%s", async (_label, xml) => {
    const result = await validator.validateEvent(xml);

    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("refuses an event with a DOCTYPE, in another encoding, or over 64 KiB, before the parser sees it", async () => {
    const valid = fixture("event", "valid/approved.xml");

    expect(await validator.validateEvent(valid.replace("<DecisionEvent", "<!DOCTYPE x><DecisionEvent"))).toEqual({ valid: false, findings: [DOCTYPE] });
    expect(await validator.validateEvent(valid.replace("UTF-8", "ISO-8859-1"))).toEqual({
      valid: false,
      findings: [{ element: "(document)", rule: "encoding must be UTF-8" }],
    });
    expect(await validator.validateEvent(valid + " ".repeat(64 * 1024))).toEqual({
      valid: false,
      findings: [{ element: "(document)", rule: "document too large" }],
    });
  });
});

describe("KNOWN_ELEMENTS", () => {
  it("is exactly the list of elements declared in contracts/xsd/*.xsd", () => {
    const declared = new Set<string>();
    for (const file of ["submission.xsd", "reply.xsd", "event.xsd", "common-types.xsd"]) {
      const text = readFileSync(new URL(file, XSD_DIRECTORY), "utf8");
      for (const match of text.matchAll(/<xs:element\s+name="([^"]+)"/g)) declared.add(match[1] ?? "");
    }

    expect([...KNOWN_ELEMENTS].sort()).toEqual([...declared].sort());
  });
});

describe("hostile input", () => {
  it("refuses a billion-laughs document without expanding it, and fast", async () => {
    const laughs = ['<?xml version="1.0"?>', "<!DOCTYPE lolz [", '<!ENTITY lol "lol">'];
    for (let level = 1; level <= 9; level++) {
      laughs.push(`<!ENTITY lol${level} "${`&lol${level === 1 ? "" : level - 1};`.repeat(10)}">`);
    }
    laughs.push("]>", "<lolz>&lol9;</lolz>");
    const started = performance.now();

    const result = await validator.validateReply(laughs.join("\n"));

    expect(result).toEqual({ valid: false, findings: [DOCTYPE] });
    // A refusal on the raw text: no worker thread, no WebAssembly. Well under one call to xmllint.
    expect(performance.now() - started).toBeLessThan(20);
  });

  it("refuses a DOCTYPE hidden in a comment or a CDATA section (a false alarm is cheap, see the code)", async () => {
    const withComment = fixture("reply", "valid/accepted.xml").replace("<MessageId>", "<!-- <!DOCTYPE x> --><MessageId>");

    expect(await validator.validateReply(withComment)).toEqual({ valid: false, findings: [DOCTYPE] });
  });

  it("refuses a document over 64 KiB, counted in bytes and not in characters", async () => {
    // 22 000 emoji are 22 000 characters (44 000 UTF-16 units) but 88 000 bytes.
    const big = fixture("reply", "valid/accepted.xml").replace("<Result>", `<Result>${"😀".repeat(22_000)}`);

    expect(await validator.validateReply(big)).toEqual({
      valid: false,
      findings: [{ element: "(document)", rule: "document too large" }],
    });
  });

  it("reports a deeply nested document as not valid instead of crashing", async () => {
    const deep = "<a>".repeat(2000) + "</a>".repeat(2000);

    expect(await validator.validateReply(deep)).toEqual({ valid: false, findings: [NOT_WELL_FORMED] });
  });

  it("reports an empty document and a NUL character as not valid", async () => {
    expect(await validator.validateSubmission("")).toEqual({ valid: false, findings: [NOT_WELL_FORMED] });
    const withNul = fixture("submission", "valid/minimal.xml").replace("Partner OK", "Part\u0000ner");
    expect(await validator.validateSubmission(withNul)).toEqual({ valid: false, findings: [NOT_WELL_FORMED] });
  });

  it("does not reach out to the network or the disk for an schemaLocation in the document", async () => {
    const xml = fixture("reply", "valid/accepted.xml").replace(
      'version="1"',
      'version="1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:aws-starter:reply:v1 http://127.0.0.1:1/evil.xsd"',
    );

    // Still valid, because the schema we passed in is the one that counts, and no request is made.
    expect(await validator.validateReply(xml)).toEqual({ valid: true });
  });
});

describe("concurrent validations", () => {
  it("give every caller its own correct result", async () => {
    const good = fixture("submission", "valid/minimal.xml");
    const emptySubject = fixture("submission", "invalid/subject-empty.xml");
    const longName = fixture("submission", "invalid/recipient-too-long.xml");
    const notXml = fixture("submission", "invalid/not-xml.xml");
    const documents = [good, emptySubject, longName, good, notXml, emptySubject, good, longName, notXml, good];

    const together = await Promise.all(documents.map((xml) => validator.validateSubmission(xml)));
    const oneByOne = [];
    for (const xml of documents) oneByOne.push(await validator.validateSubmission(xml));

    expect(together).toEqual(oneByOne);
    expect(together.map((result) => result.valid)).toEqual([true, false, false, true, false, false, true, false, false, true]);
  });

  it("do not mix the submission schema and the reply schema", async () => {
    const [asSubmission, asReply] = await Promise.all([
      validator.validateSubmission(fixture("reply", "valid/accepted.xml")),
      validator.validateReply(fixture("submission", "valid/minimal.xml")),
    ]);

    expect(asSubmission).toEqual({ valid: false, findings: [{ element: "Reply", rule: "unexpected root element" }] });
    expect(asReply).toEqual({ valid: false, findings: [{ element: "Submission", rule: "unexpected root element" }] });
  });
});
