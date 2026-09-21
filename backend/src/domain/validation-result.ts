import type { Problem } from "./exchange";

// The outcome of checking a document against a schema. It is deliberately small: yes, or
// the list of problems. A problem names the element and the rule and never the value found
// in the document, so a result can be stored and logged without leaking the request text.
export type ValidationResult = { valid: true } | { valid: false; findings: Problem[] };

// The rules of the findings that say "this document could not even be read", as opposed to
// "it was read and breaks the schema". They are produced by the XSD validator
// (src/clients/xsd-xml-validator.ts and src/clients/xsd-findings.ts), which uses these
// constants, so the words cannot drift apart. The webhook answers 400 for them and 422 for
// every other finding (contracts/webhook-api.md, steps 4 and 5).
export const UNREADABLE_DOCUMENT_RULES = {
  notWellFormed: "not well-formed XML",
  doctype: "DOCTYPE not allowed",
  encoding: "encoding must be UTF-8",
  tooLarge: "document too large",
} as const;

/** True when a failed validation is about the document as a whole not being readable. */
export function isUnreadableDocument(result: { valid: false; findings: Problem[] }): boolean {
  const unreadable: readonly string[] = Object.values(UNREADABLE_DOCUMENT_RULES);
  return result.findings.some((finding) => unreadable.includes(finding.rule));
}
