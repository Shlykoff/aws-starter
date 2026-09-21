import type { PartnerAnswer } from "../domain/partner-answer";

// What the delivery service knows about the recipient: hand over one XML document, get back
// what came back. The client only does HTTP. It decides nothing about the answer: what a
// status code or a body MEANS is the job of the reply reader (src/domain/reply-reader.ts).
export interface PartnerSubmission {
  /** The Submission document, ready to send. */
  xml: string;
  /** The MessageId of the submission (the request id): the recipient logs it, informational. */
  idempotencyKey: string;
  /** Sent in the X-API-Key header. Never logged. */
  apiKey: string;
}

export interface PartnerClient {
  /**
   * POSTs the submission. It never throws because of what the recipient does or says
   * (an error status, a timeout, a broken body): all of that is a `PartnerAnswer`.
   */
  send(submission: PartnerSubmission): Promise<PartnerAnswer>;
}
