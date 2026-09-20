import { container } from "../container";
import { createHandler, getOwnerId, jsonResponse } from "../lib/http";
import type { Logger } from "../lib/logger";
import type { RequestService } from "../services/request-service";
import { TOKENS } from "../tokens";

// GET /requests. Resolved once at module scope (see create-request.ts).
const service = container.get<RequestService>(TOKENS.RequestService);
const logger = container.get<Logger>(TOKENS.Logger);

export const handler = createHandler(logger, async (event) => {
  const ownerId = getOwnerId(event);

  const items = await service.list(ownerId);
  return jsonResponse(200, { items });
});
