import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { AuthStore, AuthStoreProvider } from "@/features/auth";
import { ExchangeStore, ExchangeStoreProvider } from "@/entities/exchange";
import { RequestsStore, RequestsStoreProvider } from "@/entities/request";
import { makeAuthClient, makeExchangeApi, makeRequestsApi } from "./factories";

// Renders a component the way the app does: with the stores in context and inside a
// router. `path` is the route pattern to mount `ui` on (needed when it reads URL params).
export function renderWithProviders(
  ui: ReactElement,
  options: {
    auth?: AuthStore;
    requests?: RequestsStore;
    exchange?: ExchangeStore;
    route?: string;
    path?: string;
  } = {},
) {
  const auth = options.auth ?? new AuthStore(makeAuthClient(), { logoutUrl: "https://auth.example/logout" });
  const requests = options.requests ?? new RequestsStore(makeRequestsApi());
  const exchange = options.exchange ?? new ExchangeStore(makeExchangeApi());
  const { route = "/", path } = options;

  const result = render(
    <AuthStoreProvider store={auth}>
      <RequestsStoreProvider store={requests}>
        <ExchangeStoreProvider store={exchange}>
          <MemoryRouter initialEntries={[route]}>
            {path ? (
              <Routes>
                <Route path={path} element={ui} />
                <Route path="*" element={<p>elsewhere</p>} />
              </Routes>
            ) : (
              ui
            )}
          </MemoryRouter>
        </ExchangeStoreProvider>
      </RequestsStoreProvider>
    </AuthStoreProvider>,
  );

  return { ...result, auth, requests, exchange, user: userEvent.setup() };
}
