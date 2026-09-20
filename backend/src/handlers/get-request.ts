import { container } from "../container";
import { createHandler, getOwnerId, jsonResponse } from "../lib/http";
import type { Logger } from "../lib/logger";
import type { RequestService } from "../services/request-service";
import { TOKENS } from "../tokens";

// GET /requests/{id}. Resolved once at module scope (see create-request.ts).
const service = container.get<RequestService>(TOKENS.RequestService);
const logger = container.get<Logger>(TOKENS.Logger);

export const handler = createHandler(logger, async (event) => {
  const ownerId = getOwnerId(event);

  // API Gateway always fills `id` for this route. If it were ever missing, the empty
  // string is not a valid ULID, so the service answers 404.
  const request = await service.get(ownerId, event.pathParameters?.id ?? "");
  return jsonResponse(200, request);
});
