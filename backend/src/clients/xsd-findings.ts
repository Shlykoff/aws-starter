import type { Problem } from "../domain/exchange";
import { UNREADABLE_DOCUMENT_RULES } from "../domain/validation-result";

// Turns the error lines of libxml2 into problems that are safe to store and to log.
//
// The reason this file exists: libxml2 QUOTES the offending value in its messages
// ("The value 'Acme #1' is not accepted by the pattern ..."), and the parser errors print
// the line of the document. Those values are personal data, and they must never reach the
// exchange record, a log line or an error message. So nothing of a message is passed on.
// The output is built from two CLOSED lists only:
//   - the name of the element, and only if it is one of the elements of our schemas,
//   - the rule, a short fixed phrase chosen by the SHAPE of the message.
// Whatever a document contains, and however it breaks a message (a value with a line break
// splits one message into several lines), the worst outcome is a wrong entry of the lists,
// never text from the document.

// Where a problem belongs to the whole document and not to one element.
export const WHOLE_DOCUMENT = "(document)";
// An element whose name is not in the list below: somebody else chose that name.
const UNKNOWN_ELEMENT = "(unknown)";

// The local names of every element of contracts/xsd/*.xsd. A test compares this list with
// the schema files, so a new element cannot be forgotten.
export const KNOWN_ELEMENTS: ReadonlySet<string> = new Set([
  "Submission", "Header", "MessageId", "SentAt", "Sender", "Recipient", "Name", "Content", "Subject", "Text",
  "Reply", "RelatesTo", "ReceivedAt", "Result", "Status", "Code", "Description",
  "DecisionEvent", "EventId", "OccurredAt", "Decision", "Reason",
]);

// The message shapes we know, in the order they are tried. Each pattern is anchored at the
// start, on the text after "Element '...': ", so a value inside the message cannot pass for
// a shape that belongs to another rule.
const RULES: readonly (readonly [RegExp, string])[] = [
  [/^\[facet 'minLength'\]/, "too short"],
  [/^\[facet 'maxLength'\]/, "too long"],
  [/^\[facet 'pattern'\]/, "does not match the allowed pattern"],
  [/^\[facet 'enumeration'\]/, "value not allowed"],
  [/^'.*' is not a valid value of the atomic type /, "not a valid value of its type"],
  [/^Missing child element\(s\)\./, "missing child element"],
  [/^This element is not expected\./, "unexpected element"],
  [/^The attribute '.*' is required but missing\./, "missing attribute"],
  [/^The attribute '.*' is not allowed\./, "unexpected attribute"],
  [/^No matching global declaration available for the validation root\./, "unexpected root element"],
  [/^Character content is not allowed/, "text not allowed here"],
  [/^Element content is not allowed/, "unexpected child element"],
];

const FALLBACK_RULE = "schema violation";
const NOT_WELL_FORMED: Problem = { element: WHOLE_DOCUMENT, rule: UNREADABLE_DOCUMENT_RULES.notWellFormed };

// One line of the schema errors: `<file>:<line>: Schemas validity error : Element '{ns}Name'...`.
// The optional `, attribute '...'` part says that the value of an attribute is meant.
const SCHEMA_ERROR = /Schemas validity error : Element '([^']*)'(, attribute '[^']*')?: (.*)$/s;

// A document with hundreds of problems needs no hundreds of lines in the record.
const MAX_FINDINGS = 20;

/** The problems behind the error lines of one validation. There is always at least one. */
export function toFindings(errors: readonly { rawMessage: string }[]): Problem[] {
  const findings: Problem[] = [];
  for (const { rawMessage } of errors) {
    const finding = toFinding(rawMessage);
    if (finding === undefined) continue; // a context line, a warning, a piece of a broken message
    if (findings.some((known) => known.element === finding.element && known.rule === finding.rule)) continue;
    findings.push(finding);
    if (findings.length === MAX_FINDINGS) break;
  }
  // "Not valid, but nothing we recognise" must never look like "valid".
  return findings.length > 0 ? findings : [{ element: WHOLE_DOCUMENT, rule: FALLBACK_RULE }];
}

function toFinding(rawMessage: string): Problem | undefined {
  if (rawMessage.includes(" parser error : ")) return NOT_WELL_FORMED;

  const match = SCHEMA_ERROR.exec(rawMessage);
  if (match === null) return undefined;
  const [, qualifiedName = "", attribute, text = ""] = match;

  // libxml2 writes names as {namespace}Local. Only the local part is kept.
  const localName = qualifiedName.slice(qualifiedName.lastIndexOf("}") + 1);
  const element = KNOWN_ELEMENTS.has(localName) ? localName : UNKNOWN_ELEMENT;

  const rule = RULES.find(([shape]) => shape.test(text))?.[1] ?? FALLBACK_RULE;
  // "value not allowed" on the element Submission would suggest the element, not its attribute.
  const aboutAttribute = attribute !== undefined && !rule.includes("attribute");
  return { element, rule: aboutAttribute ? `attribute ${rule}` : rule };
}
