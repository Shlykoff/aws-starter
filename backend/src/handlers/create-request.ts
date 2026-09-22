import { container } from "../container";
import { createRequestSchema } from "../domain/create-request";
import { MisconfigurationError } from "../lib/errors";
import { createHandler, getHeader, getOwnerId, jsonResponse, parseJsonBody } from "../lib/http";
import type { Logger } from "../lib/logger";
import type { RequestService } from "../services/request-service";
import { TOKENS } from "../tokens";

// POST /requests. Resolved once at module scope, so the cold start pays for it once and
// every warm invocation reuses it.
const service = container.get<RequestService>(TOKENS.RequestService);
const logger = container.get<Logger>(TOKENS.Logger);

export const handler = createHandler(logger, async (event, log) => {
  const ownerId = getOwnerId(event);
  const input = parseJsonBody(event, createRequestSchema);

  // The caller's own access token, unmodified: the service uses it (not the `sub` claim) to
  // read the sender's verified e-mail from Cognito's GetUser, purely as a display identity for
  // the outgoing XML, never for authorization. A protected route always carries it; if it were
  // ever missing, the API Gateway authorizer could not have run either, so that is our fault.
  const accessToken = getHeader(event, "authorization");
  if (accessToken === undefined) {
    throw new MisconfigurationError("Authorization header missing on an authorized route");
  }

  const request = await service.create(ownerId, input, accessToken, log);
  return jsonResponse(201, request);
});
