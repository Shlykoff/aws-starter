import { describe, expect, it } from "vitest";
import { buildSubmissionXml } from "../../src/domain/submission-xml";
import type { SubmissionInput } from "../../src/domain/submission-xml";
import { createRealValidator } from "../helpers/contracts";

const validator = createRealValidator();

const input = (overrides: Partial<SubmissionInput> = {}): SubmissionInput => ({
  messageId: "01M30JDSMHY8CRX59V35WV731S",
  sentAt: new Date("2026-09-21T10:00:00.123Z"),
  senderEmail: "sender@example.test",
  subject: "Delivery schedule",
  text: "Please confirm the schedule for next week.",
  ...overrides,
});

function build(overrides: Partial<SubmissionInput> = {}): string {
  const result = buildSubmissionXml(input(overrides));
  if (!result.ok) throw new Error("expected the XML to be built");
  return result.xml;
}

// The text of an element, as an XML parser would give it back (the five predefined entities
// and the character references we write). Enough to check that escaping round-trips.
const unescape = (text: string): string =>
  text
    .replaceAll("&#13;", "\r")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
const textOf = (xml: string, element: string): string => {
  const match = new RegExp(`<${element}>([\\s\\S]*?)</${element}>`).exec(xml);
  return unescape(match?.[1] ?? "<missing>");
};

describe("buildSubmissionXml: the document", () => {
  it("writes the document of contracts/xsd/submission.xsd from the values", async () => {
    const xml = build();

    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Submission xmlns="urn:aws-starter:submission:v1" version="1">',
        "  <Header>",
        "    <MessageId>01M30JDSMHY8CRX59V35WV731S</MessageId>",
        "    <SentAt>2026-09-21T10:00:00.123Z</SentAt>",
        "    <Sender><Name>sender@example.test</Name></Sender>",
        "    <Recipient><Name>Pharmacy</Name></Recipient>",
        "  </Header>",
        "  <Content>",
        "    <Subject>Delivery schedule</Subject>",
        "    <Text>Please confirm the schedule for next week.</Text>",
        "  </Content>",
        "</Submission>",
      ].join("\n"),
    );
    // ... and libxml2 agrees with the schema: the namespace and the shape are the contract's.
    expect(await validator.validateSubmission(xml)).toEqual({ valid: true });
  });

  it("uses the clock value as SentAt, in UTC", () => {
    const xml = build({ sentAt: new Date("2026-01-02T03:04:05.000Z") });

    expect(textOf(xml, "SentAt")).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("buildSubmissionXml: text that has to be escaped", () => {
  it("escapes & < > so that the text cannot become markup", () => {
    const xml = build({ text: "Fish & chips <3 a > b" });

    expect(xml).toContain("<Text>Fish &amp; chips &lt;3 a &gt; b</Text>");
  });

  it("does not let text close its element and add one of its own", async () => {
    const hostile = "</Text><Injected/><Text>";
    const xml = build({ text: hostile });

    expect(xml).not.toContain("<Injected/>");
    expect(textOf(xml, "Text")).toBe(hostile);
    expect(await validator.validateSubmission(xml)).toEqual({ valid: true });
  });

  it("escapes ]]> and does not double-escape text that already looks escaped", () => {
    const xml = build({ text: "a ]]> b &amp; c" });

    expect(xml).toContain("<Text>a ]]&gt; b &amp;amp; c</Text>");
    expect(textOf(xml, "Text")).toBe("a ]]> b &amp; c");
  });

  it("escapes the sender's e-mail and the subject too", () => {
    const xml = build({ senderEmail: "Smith & Sons", subject: "<b>Sale</b>" });

    expect(xml).toContain("<Sender><Name>Smith &amp; Sons</Name></Sender>");
    expect(xml).toContain("<Subject>&lt;b&gt;Sale&lt;/b&gt;</Subject>");
  });

  it("keeps quotes as they are: they are only special inside attribute values", () => {
    const xml = build({ text: `say "hi" and 'bye'` });

    expect(xml).toContain(`<Text>say "hi" and 'bye'</Text>`);
  });
});

describe("buildSubmissionXml: the text the user wrote comes out as it went in", () => {
  it.each([
    ["an emoji", "Please confirm 😀 by Friday"],
    ["Cyrillic", "Подтвердите график поставки"],
    ["right-to-left text", "مرحبا بالعالم שלום"],
    ["a tab and line breaks", "line one\n\tindented\n\nline four"],
    ["spaces at the start and the end", "  padded  "],
    ["combining marks", "é and ñ"],
  ])("%s", async (_label, text) => {
    const xml = build({ text });

    expect(textOf(xml, "Text")).toBe(text);
    expect(await validator.validateSubmission(xml)).toEqual({ valid: true });
  });

  it("writes a carriage return as &#13;, because a raw one would be turned into a line feed", () => {
    // XML 1.0, section 2.11: a parser normalises CR LF and a lone CR to LF. The character
    // reference is not normalised, so the text arrives exactly as it was written.
    const xml = build({ text: "one\r\ntwo\rthree" });

    expect(xml).toContain("<Text>one&#13;\ntwo&#13;three</Text>");
    expect(xml).not.toContain("\r");
    expect(textOf(xml, "Text")).toBe("one\r\ntwo\rthree");
  });
});

describe("buildSubmissionXml: text that XML 1.0 cannot carry", () => {
  it.each([
    ["a NUL", "a\u0000b"],
    ["a backspace", "a\u0008b"],
    ["an escape character", "a\u001Bb"],
    ["a form feed", "a\u000Cb"],
    ["U+FFFE", "a￾b"],
    ["U+FFFF", "a￿b"],
    ["a lone high surrogate", "a\uD800b"],
    ["a lone low surrogate", "a\uDC00b"],
    ["half an emoji at the end", "smile \uD83D"],
  ])("refuses %s in the text", (_label, text) => {
    expect(buildSubmissionXml(input({ text }))).toEqual({
      ok: false,
      reason: "unrepresentable",
      elements: ["Text"],
    });
  });

  it("names every element that has such a character, and never the character", () => {
    const result = buildSubmissionXml(
      input({ subject: "bad\u0000subject", senderEmail: "bad\u0001name", text: "fine" }),
    );

    expect(result).toEqual({ ok: false, reason: "unrepresentable", elements: ["Name", "Subject"] });
    expect(JSON.stringify(result)).not.toContain("bad");
  });

  it("does not refuse characters that are legal, even the ones XML calls discouraged", () => {
    const legal = "tab\t lf\n cr\r \u0085 \u007F ퟿  � \u{10000} \u{10FFFF}";

    expect(buildSubmissionXml(input({ text: legal })).ok).toBe(true);
  });
});

describe("buildSubmissionXml: the limits belong to the schema, not to the builder", () => {
  it("builds text that is too long, and the schema check then finds it (outcome invalid_request)", async () => {
    const xml = build({ text: "x".repeat(5001), subject: "s".repeat(201) });

    const result = await validator.validateSubmission(xml);

    expect(result).toEqual({
      valid: false,
      findings: [
        { element: "Subject", rule: "too long" },
        { element: "Text", rule: "too long" },
      ],
    });
  });

  it("builds a sender e-mail that the recipient's schema refuses, and the schema check finds it", async () => {
    const xml = build({ senderEmail: "Acme #1" });

    expect(await validator.validateSubmission(xml)).toEqual({
      valid: false,
      findings: [{ element: "Name", rule: "does not match the allowed pattern" }],
    });
  });
});
