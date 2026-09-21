import { parseXmlRoot } from "./xml-root";
import type { Element } from "@xmldom/xmldom";

// Reads the values out of a Reply document (contracts/xsd/reply.xsd).
//
// Call it only for a document that already passed reply.xsd and the DOCTYPE refusal
// (src/clients/xsd-xml-validator.ts): libxml2 is the judge of what is valid, this is only
// the reader. A real XML parser does the reading, because the same Reply can be written in
// many ways (a prefix instead of the default namespace, comments, CDATA, `&amp;`), and
// looking for `<Status>` in the text would find the wrong thing in some of them.

const REPLY_NAMESPACE = "urn:aws-starter:reply:v1";

export interface ReplyFacts {
  status: "Accepted" | "Rejected";
  /** Present only when the Reply carries a Code element. */
  code?: string;
  /** Present only when the Reply carries a Description element. */
  description?: string;
  /** The recipient's own id of this answer (a UUID). */
  messageId: string;
  /** The MessageId of our submission, when the recipient could read it. */
  relatesTo?: string;
}

// The first child element with this local name in the reply namespace. Only direct
// children are looked at: the schema puts every element at a fixed place.
function child(parent: Element, name: string): Element | undefined {
  return Array.from(parent.children).find(
    (element) => element.localName === name && element.namespaceURI === REPLY_NAMESPACE,
  );
}

/** The values of the Reply, or `undefined` if the document does not have the expected shape. */
export function readReplyFacts(xml: string): ReplyFacts | undefined {
  let root: Element | null;
  try {
    root = parseXmlRoot(xml);
  } catch {
    // The parser refused it. (The error is not kept: its text may quote the document.)
    return undefined;
  }
  if (root === null || root.localName !== "Reply" || root.namespaceURI !== REPLY_NAMESPACE) {
    return undefined;
  }

  const result = child(root, "Result");
  const status = result && child(result, "Status")?.textContent;
  const messageId = child(root, "MessageId")?.textContent;
  if (result === undefined || (status !== "Accepted" && status !== "Rejected") || !messageId) {
    return undefined;
  }

  return {
    status,
    // `textContent` of an element joins its text and CDATA and skips comments, which is the
    // value the schema validated.
    code: child(result, "Code")?.textContent ?? undefined,
    description: child(result, "Description")?.textContent ?? undefined,
    messageId,
    relatesTo: child(root, "RelatesTo")?.textContent ?? undefined,
  };
}
