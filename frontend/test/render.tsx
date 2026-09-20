import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { AuthStore, AuthStoreProvider } from "@/features/auth";
import { RequestsStore, RequestsStoreProvider } from "@/entities/request";
import { makeAuthClient, makeRequestsApi } from "./factories";

// Renders a component the way the app does: with the stores in context and inside a
// router. `path` is the route pattern to mount `ui` on (needed when it reads URL params).
export function renderWithProviders(
  ui: ReactElement,
  options: { auth?: AuthStore; requests?: RequestsStore; route?: string; path?: string } = {},
) {
  const auth = options.auth ?? new AuthStore(makeAuthClient(), { logoutUrl: "https://auth.example/logout" });
  const requests = options.requests ?? new RequestsStore(makeRequestsApi());
  const { route = "/", path } = options;

  const result = render(
    <AuthStoreProvider store={auth}>
      <RequestsStoreProvider store={requests}>
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
      </RequestsStoreProvider>
    </AuthStoreProvider>,
  );

  return { ...result, auth, requests, user: userEvent.setup() };
}
