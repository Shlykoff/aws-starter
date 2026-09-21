import type { ApiClient } from "@/shared/api";
import { exchangeSchema, type Exchange } from "../model/types";

// The one call of docs/api.md for this entity. The store depends on this interface, not on
// fetch, so tests can hand it a fake. A 204 (the request exists, no delivery attempt yet)
// has no body and becomes null; a 404 (no such request) arrives as an ApiError. The store
// decides what each of them means.
export interface ExchangeApi {
  get(requestId: string): Promise<Exchange | null>;
}

export function createExchangeApi(client: ApiClient): ExchangeApi {
  return {
    async get(requestId) {
      // encodeURIComponent: the id ends up in the URL path, never trust it to be plain.
      const data = await client.get(`/requests/${encodeURIComponent(requestId)}/exchange`);
      // The client gives `undefined` for a response without a body: that is the 204.
      if (data === undefined) return null;
      return exchangeSchema.parse(data);
    },
  };
}
