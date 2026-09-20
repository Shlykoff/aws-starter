import { z } from "zod";

// The body of POST /requests. Limits come from docs/api.md.
//
// - `.trim()` runs before `.min(1)`, so a value made only of spaces is rejected.
// - `strictObject` rejects unknown keys. That matters for security: a client that sends
//   `owner` or `status` gets a 400 instead of being silently ignored.
export const createRequestSchema = z.strictObject({
  partner: z.string().trim().min(1).max(100),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
});

export type CreateRequestInput = z.infer<typeof createRequestSchema>;
