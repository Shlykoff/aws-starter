import { container } from "../container-exchange";
import { createHandler, emptyResponse, getOwnerId, jsonResponse } from "../lib/http";
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
  const noStore = { "cache-control": "no-store" };

  // The request is the caller's own, but no delivery attempt is recorded yet: 204, no body. It is
  // not an error, so it is not a 404 (a browser logs those, and the API's 4XX metric counts them).
  // `no-store` is on it too: the answer changes as soon as the first attempt is made.
  if (exchange === undefined) return emptyResponse(204, noStore);

  return jsonResponse(200, exchange, noStore);
});
