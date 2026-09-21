import type { XmlValidator } from "../clients/xml-validator";
import type { StoredClientDecision } from "../domain/client-decision";
import { readEventFacts } from "../domain/event-facts";
import { describeProblem } from "../domain/exchange";
import { UNREADABLE_DOCUMENT_RULES, isUnreadableDocument } from "../domain/validation-result";
import { checkSignatureHeaders, signatureMatches } from "../domain/webhook-signature";
import type { LogFields, Logger } from "../lib/logger";
import type { DecisionRepository, RecordOutcome } from "../repositories/decision-repository";
import type { SecretProvider } from "../repositories/secret-provider";

// The largest body we accept, in bytes (contracts/webhook-api.md).
export const MAX_BODY_BYTES = 65_536;

/**
 * What happened to one call of the webhook. The handler turns it into an HTTP status in one
 * table; the words are also what the log line says.
 */
export type WebhookOutcome =
  | RecordOutcome // applied, duplicate, ignored, unknown_request
  | "too_large"
  | "unauthorized"
  | "unsupported_media"
  | "malformed" // not well-formed XML, or a DOCTYPE
  | "schema_invalid";

/** One call, as plain values (the handler maps the API Gateway event to this). */
export interface WebhookCall {
  /** The body exactly as sent, as bytes: the signature covers these bytes. Empty when there was none. */
  body: Buffer;
  /** The header values; `undefined` when the header was not sent. */
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  contentType: string | undefined;
}

// A decision of the client on a delivered request (docs/api.md, "Client decision (webhook)").
// The checks run in the order of contracts/webhook-api.md ("What the sender does, in this
// order"): the cheap ones first, so that nothing expensive (SSM, the XSD validator, DynamoDB)
// happens for a caller who is not authenticated.
//
// LOGGING: this class logs ids, the outcome word, problem counts, rule names and fixed words
// for a failed signature, and nothing else. Never the body, the `Reason` of the event, a header,
// the signature or the token. (The body and the reason are text from another system; the
// signature and the token are secrets.)
export class WebhookService {
  constructor(
    private readonly token: SecretProvider,
    private readonly validator: XmlValidator,
    private readonly decisions: DecisionRepository,
    // A parameter only so that tests can fix the clock.
    private readonly now: () => Date = () => new Date(),
  ) {}

  async receive(call: WebhookCall, log: Logger): Promise<WebhookOutcome> {
    // Every outcome writes exactly one line, here.
    const finish = (outcome: WebhookOutcome, fields: LogFields = {}): WebhookOutcome => {
      const accepted = outcome === "applied" || outcome === "duplicate" || outcome === "ignored";
      log[accepted ? "info" : "warn"]("Webhook handled", { outcome, ...fields });
      return outcome;
    };
    const now = this.now();

    // 1. Size. Before anything else: it costs nothing and bounds every later step.
    if (call.body.length > MAX_BODY_BYTES) return finish("too_large", { bytes: call.body.length });

    // 2. Signature. The shape of the headers and the age of the request first, without the
    // token: junk from the internet is refused here, and never costs a call to SSM. The token
    // is read only for a request that looks signed. A wrong signature does NOT clear the
    // token's cache (which would let anybody force a read of SSM per request), so a rotated
    // token is picked up when the 5 minutes of the cache end.
    const checked = checkSignatureHeaders(
      call.timestampHeader,
      call.signatureHeader,
      Math.floor(now.getTime() / 1000),
    );
    if (!checked.ok) return finish("unauthorized", { signatureProblem: checked.problem });
    if (!signatureMatches(await this.token.get(), checked.headers, call.body)) {
      return finish("unauthorized", { signatureProblem: "signature_mismatch" });
    }

    // 3. Media type: application/xml, parameters (";charset=utf-8") and case ignored.
    if (!isXmlMediaType(call.contentType)) return finish("unsupported_media");

    // 4 and 5. Well-formed, no DOCTYPE, valid against event.xsd. libxml2 (the validator) is the
    // judge; the kind of finding tells 400 (could not be read) from 422 (read, breaks the schema).
    let xml: string;
    try {
      // Strict: a byte sequence that is not UTF-8 is an error, not silently replaced by
      // U+FFFD (which would change the text that was signed). A leading BOM is removed.
      xml = new TextDecoder("utf-8", { fatal: true }).decode(call.body);
    } catch {
      return finish("malformed", { problems: [`(document): ${UNREADABLE_DOCUMENT_RULES.notWellFormed}`] });
    }
    const validation = await this.validator.validateEvent(xml);
    if (!validation.valid) {
      return finish(isUnreadableDocument(validation) ? "malformed" : "schema_invalid", {
        problemCount: validation.findings.length,
        problems: validation.findings.map(describeProblem),
      });
    }
    const facts = readEventFacts(xml);
    if (facts === undefined) {
      // libxml2 accepted it but it cannot be read as an event (for example an OccurredAt
      // that is not a point in time in JavaScript): the two parsers disagree, so it is invalid.
      return finish("schema_invalid", { problems: ["(document): cannot be read as an event"] });
    }

    // 6 and 7. Find the request, apply the event. The repository does both (see
    // DynamoDecisionRepository); a request that does not exist is `unknown_request`.
    const decision: StoredClientDecision = {
      decision: facts.decision,
      ...(facts.reason !== undefined && { reason: facts.reason }),
      at: new Date(facts.occurredAtMs).toISOString(),
      receivedAt: now.toISOString(),
      eventId: facts.eventId,
    };
    const outcome = await this.decisions.recordDecision(facts.relatesTo, decision, facts.occurredAtMs);
    // The ids and the decision come from fields the schema checked (a ULID, a UUID, one of two words).
    return finish(outcome, {
      requestId: facts.relatesTo,
      eventId: facts.eventId,
      decision: facts.decision,
      occurredAtMs: facts.occurredAtMs,
    });
  }
}

// "application/xml", in any case, with or without parameters such as "; charset=utf-8".
function isXmlMediaType(contentType: string | undefined): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/xml";
}
