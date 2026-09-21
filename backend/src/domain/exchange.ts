import { z } from "zod";

// The Exchange of docs/api.md ("Endpoints" and "The exchange record"): what the worker
// recorded about the LATEST delivery attempt of one request. It is stored as one JSON object
// in S3 and returned as it is by GET /requests/{id}/exchange.
//
// It is a zod schema, and the type is derived from it, so the shape is written down once.
// The schema is also used when the record is read back: the object is data we wrote, but a
// schema that drifted between two deployments must fail loudly, not send garbage to a client.

export const EXCHANGE_OUTCOMES = [
  "delivered", // the recipient accepted it
  "refused", // the recipient said Rejected, or another final 4xx
  "retry", // a temporary failure: no answer, 5xx, a broken reply, ...
  "invalid_request", // our XML failed submission.xsd; nobody was called
  "unrepresentable", // it could not even be written as XML; nobody was called
] as const;
export type ExchangeOutcome = (typeof EXCHANGE_OUTCOMES)[number];

// One thing that is wrong with a document: WHICH element and WHICH rule, never the value
// found in it (the value is personal data).
export const problemSchema = z.object({ element: z.string(), rule: z.string() });
export type Problem = z.infer<typeof problemSchema>;

// A problem as one line of a log: "element: rule". Both come from closed lists (see
// src/clients/xsd-findings.ts), never from the document.
export const describeProblem = ({ element, rule }: Problem): string => `${element}: ${rule}`;

export const exchangeSchema = z.object({
  /** Which attempt this describes (1 = the first): the receive count of the queue message. */
  attempt: z.number(),
  /** ISO 8601, UTC. */
  at: z.string(),
  outcome: z.enum(EXCHANGE_OUTCOMES),
  request: z.object({
    /** The XML we built; "" when it could not be built (outcome "unrepresentable"). */
    xml: z.string(),
    valid: z.boolean(),
    problems: z.array(problemSchema),
  }),
  /** What came back. `null` when nobody answered (timeout, no connection). */
  reply: z
    .object({
      httpStatus: z.number(),
      /** The body as received; `null` when there was none (or it was refused as too large). */
      xml: z.string().nullable(),
      /** True when the body is a valid Reply: reply.xsd, plus the rule about Code and Description. */
      valid: z.boolean(),
      // Read from the body when it passed reply.xsd. They are the recipient's words: shown
      // to the owner as text, never logged.
      status: z.enum(["Accepted", "Rejected"]).optional(),
      code: z.string().optional(),
      description: z.string().optional(),
    })
    .nullable(),
});

export type Exchange = z.infer<typeof exchangeSchema>;
