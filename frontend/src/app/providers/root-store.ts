import { AuthStore, createAuthStore } from "@/features/auth";
import { ExchangeStore, createExchangeApi } from "@/entities/exchange";
import { RequestsStore, createRequestsApi } from "@/entities/request";
import { createApiClient } from "@/shared/api";
import type { AppConfig } from "@/shared/config";

// All stores of the app, created once at startup and handed to React through context
// (see StoreProvider). One store per feature/entity; this is the only place that knows
// how they are wired together.
export interface RootStore {
  auth: AuthStore;
  requests: RequestsStore;
  exchange: ExchangeStore;
}

export function createRootStore(config: AppConfig): RootStore {
  const auth = createAuthStore(config);

  // The API client knows nothing about Cognito or MobX. The auth store is plugged in as
  // two plain functions: where to get the token, and what to do when the API says 401.
  const apiClient = createApiClient({
    baseUrl: config.apiUrl,
    getAccessToken: () => auth.getAccessToken(),
    onUnauthorized: () => auth.handleUnauthorized(),
  });

  return {
    auth,
    requests: new RequestsStore(createRequestsApi(apiClient)),
    exchange: new ExchangeStore(createExchangeApi(apiClient)),
  };
}
