// Builds the Submission document of contracts/xsd/submission.xsd from the values of a request.
//
// The XML is written with plain string code, no XML library: the document is small and its
// shape is fixed, and the only real work is escaping. The result is checked against
// submission.xsd afterwards (src/clients/xsd-xml-validator.ts), so a mistake here shows up as
// a validation problem, not as a message the recipient refuses.

export interface SubmissionInput {
  /** The request id (a ULID). */
  messageId: string;
  sentAt: Date;
  senderName: string;
  /** The `partner` of the request. */
  recipientName: string;
  subject: string;
  /** The `body` of the request. */
  text: string;
}

export type SubmissionXml =
  | { ok: true; xml: string }
  // Some text holds a character that XML 1.0 cannot carry at all. `elements` names where
  // (never the text itself), so the problem can be recorded without leaking a value.
  | { ok: false; reason: "unrepresentable"; elements: string[] };

// The namespace of contracts/xsd/submission.xsd. The XSD files themselves are the contract;
// this string must match their `targetNamespace`, and the fixtures test proves that it does.
const NAMESPACE = "urn:aws-starter:submission:v1";

// The characters XML 1.0 allows in a document: the `Char` production of the specification,
// https://www.w3.org/TR/xml/#charsets, written in the same order:
//   tab, line feed, carriage return | #x20-#xD7FF | #xE000-#xFFFD | #x10000-#x10FFFF
// Everything else is forbidden even as `&#0;`: most control characters (NUL, backspace,
// escape, ...), the noncharacters U+FFFE and U+FFFF, and lone surrogates (half of an emoji
// left over from a broken string). The `u` flag makes the ranges work on whole code points,
// so a valid emoji (a surrogate PAIR in JavaScript) passes and a lone surrogate does not.
// Characters that are legal but "discouraged" (for example U+0085) are not refused: XML 1.0
// allows them and the recipient's schema does not care.
const XML_CHARACTERS = /^[\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]*$/u;

// What has to change in text so that it means the same thing inside an element:
//   &  <   start a reference or a tag, so they become &amp; and &lt;
//   >      is legal on its own, but `]]>` is forbidden in text, so every > is escaped
//   \r     an XML parser turns every raw carriage return (and CR LF) into a line feed
//          (XML 1.0, section 2.11). The character reference &#13; is not touched by
//          that rule, so it keeps the text exactly as the user wrote it.
// Quotes need no escaping in text (only inside attribute values, and we write none from
// user input). Nothing else about the text is changed: spaces at the start or the end and
// blank lines stay as they are, because xs:string keeps them too.
function escapeText(text: string): string {
  return text
    .replaceAll("&", "&amp;") // first, or the & of the other replacements would be escaped again
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "&#13;");
}

export function buildSubmissionXml(input: SubmissionInput): SubmissionXml {
  // The element that holds each value, in document order.
  const values: [element: string, value: string][] = [
    ["MessageId", input.messageId],
    ["Name", input.senderName],
    ["Name", input.recipientName],
    ["Subject", input.subject],
    ["Text", input.text],
  ];
  const elements = values
    .filter(([, value]) => !XML_CHARACTERS.test(value))
    .map(([element]) => element);
  if (elements.length > 0) {
    return { ok: false, reason: "unrepresentable", elements: [...new Set(elements)] };
  }

  // Lengths and patterns are NOT checked here: that is the schema's job, and the schema
  // is the recipient's own rule set (docs/api.md, "delivery-worker", step 3).
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Submission xmlns="${NAMESPACE}" version="1">`,
    "  <Header>",
    `    <MessageId>${escapeText(input.messageId)}</MessageId>`,
    `    <SentAt>${input.sentAt.toISOString()}</SentAt>`,
    `    <Sender><Name>${escapeText(input.senderName)}</Name></Sender>`,
    `    <Recipient><Name>${escapeText(input.recipientName)}</Name></Recipient>`,
    "  </Header>",
    "  <Content>",
    `    <Subject>${escapeText(input.subject)}</Subject>`,
    `    <Text>${escapeText(input.text)}</Text>`,
    "  </Content>",
    "</Submission>",
  ].join("\n");
  return { ok: true, xml };
}
