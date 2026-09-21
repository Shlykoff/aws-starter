import type { Exchange } from "./exchange";
import type { PartnerAnswer } from "./partner-answer";
import { readReplyFacts } from "./reply-facts";
import type { ReplyFacts } from "./reply-facts";
import type { ValidationResult } from "./validation-result";

// What the sender makes of the recipient's answer: the table "How the sender reads the
// answer" in contracts/partner-api.md, in one place, as a pure function (no I/O, so every
// row of the table is a plain unit test).
//
//   200 + Accepted                                        -> delivered
//   400 or 422 + Rejected                                 -> refused (final, do not retry)
//   401, 403, 408, 429, any 5xx, no answer, a timeout     -> retry
//   any other 4xx                                         -> refused (our request is wrong)
//   a 200 without a valid Reply                           -> retry (the recipient broke the protocol)
//
// The reply is untrusted input. The caller has already refused oversized bodies and any
// DOCTYPE, and has checked the body against reply.xsd (`validation`); this function adds the
// rule XSD 1.0 cannot express, and everything the contract leaves open (below).

export interface AnswerReading {
  decision: "delivered" | "refused" | "retry";
  /** A fixed word for the logs (never text from the network): why this decision. */
  reason: string;
  /** The reply part of the exchange record; `null` when nobody answered. */
  reply: Exchange["reply"];
  /** What was read from the body; only there when the body passed reply.xsd. */
  facts: ReplyFacts | undefined;
}

// Statuses that mean "not now, or our own configuration is wrong": the request itself is
// fine, so it is tried again (docs/api.md explains why 401 and 403 are among them).
const RETRY_CLIENT_ERRORS = [401, 403, 408, 429];

/**
 * @param ourMessageId  The MessageId of the submission we sent (the request id). A Reply that
 *                      names another one is not an answer to this submission.
 * @param validation    The result of checking `answer.body` against reply.xsd; `undefined`
 *                      when there was no body to check.
 */
export function readAnswer(
  answer: PartnerAnswer,
  validation: ValidationResult | undefined,
  ourMessageId: string,
): AnswerReading {
  if (answer.kind === "no-answer") {
    return { decision: "retry", reason: answer.reason, reply: null, facts: undefined };
  }

  const { httpStatus } = answer;
  const body = inspectBody(answer, validation);
  const reply: Exchange["reply"] = {
    httpStatus,
    xml: answer.body ?? null,
    valid: body.problem === undefined,
    ...(body.facts && {
      status: body.facts.status,
      code: body.facts.code,
      description: body.facts.description,
    }),
  };
  const result = (decision: AnswerReading["decision"], reason: string): AnswerReading => ({
    decision,
    reason,
    reply,
    facts: body.facts,
  });

  // A reply that tells a different story than the HTTP status, or that answers another
  // message, cannot be trusted either way. The contract does not say what to do with it, so
  // the cautious reading applies: try again, never a silent "sent" or "rejected". The
  // recipient answers a repeated MessageId with the same stored answer, so a real fault ends
  // as `failed` with an alarm after the allowed attempts instead of being hidden.
  const contradiction = findContradiction(httpStatus, body.facts, ourMessageId);

  if (httpStatus === 200) {
    // "A 200 whose body is not a valid Reply is a protocol violation": a temporary failure.
    if (body.problem !== undefined) return result("retry", body.problem);
    if (contradiction !== undefined) return result("retry", contradiction);
    return result("delivered", "accepted");
  }

  if (httpStatus === 400 || httpStatus === 422) {
    // The body is extra information here: the status code decides, so a refusal with a
    // missing or broken body is still a refusal. Only a body that is valid and contradicts
    // the status is not believed.
    if (body.problem === undefined && contradiction !== undefined) return result("retry", contradiction);
    return result("refused", body.problem === undefined ? "rejected" : `http_${httpStatus}`);
  }

  if (RETRY_CLIENT_ERRORS.includes(httpStatus) || httpStatus >= 500) {
    return result("retry", `http_${httpStatus}`);
  }
  if (httpStatus >= 400 && httpStatus < 500) return result("refused", `http_${httpStatus}`);

  // 1xx, 3xx and every 2xx except 200. The contract defines none of them. A redirect is not
  // followed (the API key must not travel to another host), and "Accepted" is only ever
  // a 200, so none of these is proof of delivery: retry.
  return result("retry", "unexpected_status");
}

interface BodyInspection {
  /** Why the body is not a valid Reply; `undefined` when it is one. */
  problem: string | undefined;
  facts: ReplyFacts | undefined;
}

function inspectBody(
  answer: Extract<PartnerAnswer, { kind: "answer" }>,
  validation: ValidationResult | undefined,
): BodyInspection {
  const { body, bodyProblem } = answer;
  if (body === undefined) {
    return { problem: bodyProblem ? `reply_${bodyProblem}` : "reply_missing", facts: undefined };
  }
  // The caller checks every body it received. No result at all is treated as "not valid".
  if (validation === undefined || !validation.valid) {
    return { problem: "reply_invalid", facts: undefined };
  }

  const facts = readReplyFacts(body);
  // libxml2 accepted the document but it cannot be read: the two parsers disagree about it.
  if (facts === undefined) return { problem: "reply_invalid", facts: undefined };

  // The rule of contracts/README.md: Code and Description exist exactly when the status is
  // Rejected. The facts are kept even when it is broken: they help to see what went wrong.
  const rejected = facts.status === "Rejected";
  if ((facts.code !== undefined) !== rejected || (facts.description !== undefined) !== rejected) {
    return { problem: "reply_rule_violation", facts };
  }
  return { problem: undefined, facts };
}

function findContradiction(
  httpStatus: number,
  facts: ReplyFacts | undefined,
  ourMessageId: string,
): string | undefined {
  if (facts === undefined) return undefined;
  // RelatesTo is optional (the recipient leaves it out when it could not read our id), so an
  // absent one is fine. A present one must be ours.
  if (facts.relatesTo !== undefined && facts.relatesTo !== ourMessageId) {
    return "reply_relates_to_mismatch";
  }
  const acceptedStatus = httpStatus === 200;
  const refusedStatus = httpStatus === 400 || httpStatus === 422;
  if ((acceptedStatus && facts.status === "Rejected") || (refusedStatus && facts.status === "Accepted")) {
    return "status_and_reply_disagree";
  }
  return undefined;
}
