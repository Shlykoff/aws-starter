import { container } from "../container-exchange";
import { createHandler, getOwnerId, jsonResponse } from "../lib/http";
import type { Logger } from "../lib/logger";
import type { ExchangeService } from "../services/exchange-service";
import { TOKENS } from "../tokens";

// GET /requests/{id}/exchange. Resolved once at module scope (see create-request.ts).
const service = container.get<ExchangeService>(TOKENS.ExchangeService);
const logger = container.get<Logger>(TOKENS.Logger);

export const handler = createHandler(logger, async (event) => {
  const ownerId = getOwnerId(event);

  // API Gateway always fills `id` for this route. If it were ever missing, the empty
  // string is not a valid ULID, so the service answers 404.
  const exchange = await service.get(ownerId, event.pathParameters?.id ?? "");

  // The record holds the text of the request and the reply: no browser or proxy may keep a copy.
  return jsonResponse(200, exchange, { "cache-control": "no-store" });
});
