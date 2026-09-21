import type { ValidationResult } from "../domain/validation-result";

// What the delivery service needs from an XSD validator: is this document valid against the
// contract schema of a message, and if not, what is wrong (the element and the rule, never
// the value). Both methods return a result for anything they are given: a document that is
// too large, has a DOCTYPE or is not even well-formed is "not valid", not an exception. An
// exception means that the validator itself could not run.
export interface XmlValidator {
  /** Checks a Submission document against contracts/xsd/submission.xsd. */
  validateSubmission(xml: string): Promise<ValidationResult>;
  /** Checks the body of the recipient's answer against contracts/xsd/reply.xsd. */
  validateReply(xml: string): Promise<ValidationResult>;
}
