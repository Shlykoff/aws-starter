import { z } from "zod";
import { REQUEST_LIMITS } from "@/entities/request";

// The same rules as the API (backend/src/domain/create-request.ts): trim first, so a value
// made only of spaces counts as empty, then check the length. The messages are for the
// person filling in the form. The server validates again; this only saves a round trip.
const text = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `Enter the ${label}.`)
    .max(max, `The ${label} can have at most ${max} characters.`);

export const createRequestSchema = z.object({
  subject: text("subject", REQUEST_LIMITS.subject),
  body: text("message", REQUEST_LIMITS.body),
});

export type CreateRequestValues = z.input<typeof createRequestSchema>;
export type CreateRequestField = keyof CreateRequestValues;
