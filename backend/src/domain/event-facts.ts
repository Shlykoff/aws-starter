import { parseXmlRoot } from "./xml-root";
import type { Element } from "@xmldom/xmldom";
import { isDecision } from "./client-decision";
import type { Decision } from "./client-decision";

// Reads the values out of a DecisionEvent document (contracts/xsd/event.xsd).
//
// Call it only for a document that already passed event.xsd and the DOCTYPE refusal
// (src/clients/xsd-xml-validator.ts): libxml2 is the judge of what is valid, this is only
// the reader. It works like src/domain/reply-facts.ts: a real XML parser, because the same
// event can be written in many ways (a prefix, comments, CDATA, `&amp;`).

const EVENT_NAMESPACE = "urn:aws-starter:event:v1";

export interface EventFacts {
  /** The recipient's id of this event (a UUID). A repeated delivery carries the same one. */
  eventId: string;
  /** When the client acted, as epoch milliseconds (a number, so events can be put in order). */
  occurredAtMs: number;
  /** The id of our request (a ULID): the MessageId of the submission. */
  relatesTo: string;
  decision: Decision;
  /** Present only when the event carries a Reason element. */
  reason?: string;
}

// The first child element with this local name in the event namespace. Only direct children
// are looked at: the schema puts every element at a fixed place.
function child(parent: Element, name: string): Element | undefined {
  return Array.from(parent.children).find(
    (element) => element.localName === name && element.namespaceURI === EVENT_NAMESPACE,
  );
}

// The shape of an xs:dateTime that ends with a time zone, as event.xsd demands. The regex is
// there so that only this shape reaches `Date.parse`, which on its own would also accept
// formats of its own ("Sep 21 2026"). A year with a sign or more than four digits is valid
// XSD but not supported here, and is refused.
const OFFSET_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * `OccurredAt` as epoch milliseconds (any offset is converted to UTC), or `undefined` when it
 * cannot be read as a point in time.
 */
export function parseOccurredAt(text: string): number | undefined {
  // XSD ignores spaces around a dateTime, so libxml2 may have accepted them.
  const trimmed = text.trim();
  if (!OFFSET_DATE_TIME.test(trimmed)) return undefined;
  const milliseconds = Date.parse(trimmed);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

/**
 * The values of the event, or `undefined` if the document does not have the expected shape or
 * its `OccurredAt` is not a point in time. The caller answers 422 for `undefined`.
 */
export function readEventFacts(xml: string): EventFacts | undefined {
  let root: Element | null;
  try {
    root = parseXmlRoot(xml);
  } catch {
    // The parser refused it. (The error is not kept: its text may quote the document.)
    return undefined;
  }
  if (root === null || root.localName !== "DecisionEvent" || root.namespaceURI !== EVENT_NAMESPACE) {
    return undefined;
  }

  const eventId = child(root, "EventId")?.textContent;
  const occurredAt = child(root, "OccurredAt")?.textContent;
  const relatesTo = child(root, "RelatesTo")?.textContent;
  const decision = child(root, "Decision")?.textContent;
  if (!eventId || !occurredAt || !relatesTo) return undefined;
  if (!isDecision(decision)) return undefined;

  const occurredAtMs = parseOccurredAt(occurredAt);
  if (occurredAtMs === undefined) return undefined;

  // `textContent` of an element joins its text and CDATA and skips comments, which is the
  // value the schema validated.
  const reason = child(root, "Reason")?.textContent ?? undefined;
  return { eventId, occurredAtMs, relatesTo, decision, ...(reason !== undefined && { reason }) };
}
