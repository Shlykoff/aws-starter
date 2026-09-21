import { container } from "../container";
import { createRequestSchema } from "../domain/create-request";
import { createHandler, getOwnerId, jsonResponse, parseJsonBody } from "../lib/http";
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

  const request = await service.create(ownerId, input, log);
  return jsonResponse(201, request);
});
