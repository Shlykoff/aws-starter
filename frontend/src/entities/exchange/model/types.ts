import { z } from "zod";

// Mirrors the "Exchange" model in docs/api.md: what the worker recorded about the latest
// delivery attempt of one request. The type is derived from the schema, like in the
// request entity, so the API answer is checked at runtime and not just trusted.

export const EXCHANGE_OUTCOMES = ["delivered", "refused", "retry", "invalid_request", "unrepresentable"] as const;
export type ExchangeOutcome = (typeof EXCHANGE_OUTCOMES)[number];

// What the partner's answer said once it was read: the same three values as in reply.xsd.
const REPLY_STATUSES = ["Accepted", "Rejected"] as const;

// `xml` fields are text from outside (our own request text, or a third party's answer):
// they are only ever shown as text, never interpreted as markup (see XmlBlock).
export const exchangeSchema = z.object({
  attempt: z.number(),
  at: z.string(),
  outcome: z.enum(EXCHANGE_OUTCOMES),
  request: z.object({
    // Empty when the request could not be built as XML at all (outcome `unrepresentable`).
    xml: z.string(),
    valid: z.boolean(),
    // The element and the rule, never the value that was found in it.
    problems: z.array(z.object({ element: z.string(), rule: z.string() })),
  }),
  // null: no answer came back (or nothing was sent).
  reply: z
    .object({
      httpStatus: z.number(),
      // null: the answer had no body.
      xml: z.string().nullable(),
      valid: z.boolean(),
      status: z.enum(REPLY_STATUSES).optional(),
      code: z.string().optional(),
      description: z.string().optional(),
    })
    .nullable(),
});
export type Exchange = z.infer<typeof exchangeSchema>;
