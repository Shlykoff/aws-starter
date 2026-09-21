import type { Problem } from "./exchange";

// The outcome of checking a document against a schema. It is deliberately small: yes, or
// the list of problems. A problem names the element and the rule and never the value found
// in the document, so a result can be stored and logged without leaking the request text.
export type ValidationResult = { valid: true } | { valid: false; findings: Problem[] };
