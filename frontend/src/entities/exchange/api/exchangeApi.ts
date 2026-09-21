import type { ApiClient } from "@/shared/api";
import { exchangeSchema, type Exchange } from "../model/types";

// The one call of docs/api.md for this entity. The store depends on this interface, not on
// fetch, so tests can hand it a fake. A 404 (no such request, or no delivery attempt yet)
// arrives as an ApiError; the store decides what it means.
export interface ExchangeApi {
  get(requestId: string): Promise<Exchange>;
}

export function createExchangeApi(client: ApiClient): ExchangeApi {
  return {
    async get(requestId) {
      // encodeURIComponent: the id ends up in the URL path, never trust it to be plain.
      const data = await client.get(`/requests/${encodeURIComponent(requestId)}/exchange`);
      return exchangeSchema.parse(data);
    },
  };
}
