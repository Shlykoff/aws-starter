// What may be written to the logs (used by lib/logger.ts).
//
// The logs hold no message text, no partner names, no reasons, no tokens: those are personal
// data, and a log line outlives the request (14 days in CloudWatch, readable by everybody who can
// read the logs). Until now that was a rule for whoever writes a log call. This file makes it a
// property of the logger: a log FIELD is on a list, with a SHAPE for its value, and everything
// else is replaced before it is written.
//
//   - A field that is not on the list is written as "[unlisted]": the name stays (so a developer
//     sees what was logged), the value never reaches the log.
//   - A field on the list whose value has the wrong shape is written as "[rejected]". This is
//     what stops the name from being the only defence: `reason` is a fixed word in the delivery
//     worker ("http_503") and free text in an event from the recipient; the shape lets the first
//     through and stops the second, whichever name a caller picks.
//   - Adding a field is a decision made here, in a reviewed diff, with its shape.
//
// The shapes are about what the value IS (an id, a word from a closed list, a number), not about
// what it might contain, so a shape is as narrow as its field allows. Free text exists in
// exactly two fields, the message and the stack of an error, and both are scrubbed and capped
// (see `errorText`): error texts of libraries can quote the value that made them fail.

const REJECTED = Symbol("rejected");

/** Returns the value to write (possibly changed), or REJECTED. */
type Check = (value: unknown) => unknown;

const matches =
  (pattern: RegExp): Check =>
  (value) =>
    typeof value === "string" && pattern.test(value) ? value : REJECTED;

const finiteNumber: Check = (value) => (typeof value === "number" && Number.isFinite(value) ? value : REJECTED);
const boolean: Check = (value) => (typeof value === "boolean" ? value : REJECTED);

const listOf =
  (item: Check, maxItems: number): Check =>
  (value) => {
    if (!Array.isArray(value) || value.length > maxItems) return REJECTED;
    const checked = value.map(item);
    return checked.includes(REJECTED) ? REJECTED : checked;
  };

// An identifier: an id of ours or of AWS (a ULID, a UUID, a sequence number). Opaque tokens,
// no spaces, no punctuation but "-" and "_".
const ID = /^[0-9A-Za-z_-]{1,64}$/;
// A word from a closed list of ours: an outcome, a status, a reason such as "http_503".
// No spaces: prose does not pass.
const WORD = /^[A-Za-z0-9_]{1,48}$/;
// "Subject: does not match the allowed pattern": an element name and a rule, both from the
// closed lists of src/clients/xsd-findings.ts.
const PROBLEM = /^[A-Za-z()]{1,40}(: [A-Za-z0-9 '().,-]{1,80})?$/;
// "POST /requests/{id}/retry": the route template of API Gateway, never the real path. A segment
// is a lower-case word or a {parameter}: a real id (a ULID is upper case) does not fit.
const ROUTE = /^[A-Z]{3,7} (\/([a-z][a-z-]{0,30}|\{[a-z]{1,20}\})){1,6}$/;

const id = matches(ID);
const word = matches(WORD);

/**
 * The text of an error, from a library or from us. It cannot be given a narrow shape, so it is
 * cut down instead: every quoted piece is replaced (`'...'`, `"..."`, `` `...` ``: the way
 * parsers and validators quote the value that failed them, for example `Unexpected token 'a',
 * "abc" is not valid JSON`), and the length is capped.
 */
const errorText =
  (maxLength: number): Check =>
  (value) => {
    if (typeof value !== "string") return REJECTED;
    const scrubbed = value.replace(/(["'`])[^\n]*?\1/g, "$1…$1");
    return scrubbed.length <= maxLength ? scrubbed : `${scrubbed.slice(0, maxLength)}…[cut]`;
  };

const FIELDS: Record<string, Check> = {
  // ids
  awsRequestId: id,
  requestId: id,
  eventId: id,
  messageId: id,
  replyMessageId: id,
  sequenceNumber: id,
  // outcomes, statuses and reasons: words
  outcome: word,
  decision: word,
  status: word,
  wantedStatus: word,
  reason: word,
  noAnswer: word,
  replyStatus: word,
  replyCode: word,
  signatureProblem: word,
  errorName: word,
  // numbers and flags
  httpStatus: finiteNumber,
  statusCode: finiteNumber,
  occurredAtMs: finiteNumber,
  durationMs: finiteNumber,
  bytes: finiteNumber,
  receiveCount: finiteNumber,
  problemCount: finiteNumber,
  records: finiteNumber,
  messages: finiteNumber,
  sent: finiteNumber,
  rejected: finiteNumber,
  alreadyDone: finiteNumber,
  retry: finiteNumber,
  failed: finiteNumber,
  error: finiteNumber,
  undeliverable: finiteNumber,
  notAttempted: finiteNumber,
  queued: finiteNumber,
  alreadyMoved: finiteNumber,
  ignored: finiteNumber,
  malformed: finiteNumber,
  isLastAttempt: boolean,
  replyValid: boolean,
  // the route template
  route: matches(ROUTE),
  // validator findings: "element: rule" from closed lists, and element names
  problems: listOf(matches(PROBLEM), 50),
  replyProblems: listOf(matches(PROBLEM), 50),
  elements: listOf(word, 10),
  // the names of the fields of a stream image that failed the schema (never their values)
  invalidFields: listOf(matches(/^[A-Za-z0-9_.]{1,40}$/), 10),
  // free text, scrubbed and capped
  errorMessage: errorText(300),
  stack: errorText(2000),
};

// These are the keys of the line itself. A field with such a name would replace them.
const RESERVED = new Set(["level", "message"]);

/** The longest message a log call may pass: a fixed sentence, not something built from data. */
export const MAX_MESSAGE_LENGTH = 120;

/** The guard refused something. In tests and local runs this is thrown; in Lambda it is not. */
export class LogGuardError extends Error {
  constructor(problem: string) {
    super(`log guard: ${problem}`);
    this.name = "LogGuardError";
  }
}

export interface Sanitized {
  fields: Record<string, unknown>;
  /** What the guard replaced, for the strict mode: fixed sentences, never values. */
  problems: string[];
}

/** Checks the fields of one log line. `undefined` values are left out, as JSON does. */
export function sanitizeFields(fields: Record<string, unknown>): Sanitized {
  const clean: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;

    // The name is written to the log too, so it must not be able to carry data either.
    const safeName = /^[A-Za-z0-9_]{1,40}$/.test(name) ? name : "badFieldName";
    if (RESERVED.has(name) || safeName !== name) {
      problems.push(`the field name "${safeName}" is not allowed`);
      continue;
    }

    const check = FIELDS[name];
    if (check === undefined) {
      clean[name] = "[unlisted]";
      problems.push(`the field "${name}" is not on the list (src/lib/log-fields.ts)`);
      continue;
    }
    const checked = check(value);
    if (checked === REJECTED) {
      clean[name] = "[rejected]";
      problems.push(`the value of the field "${name}" does not have its shape (src/lib/log-fields.ts)`);
      continue;
    }
    clean[name] = checked;
  }
  return { fields: clean, problems };
}

/** A log message is a fixed sentence: short, one line. Longer or multi-line text is cut. */
export function sanitizeMessage(message: string): { message: string; problem?: string } {
  const singleLine = message.replace(/[\r\n\t]+/g, " ");
  if (singleLine.length <= MAX_MESSAGE_LENGTH && singleLine === message) return { message };
  return {
    message: singleLine.slice(0, MAX_MESSAGE_LENGTH),
    problem: `the message is longer than ${MAX_MESSAGE_LENGTH} characters or has line breaks: use a fixed sentence and put data in fields`,
  };
}
