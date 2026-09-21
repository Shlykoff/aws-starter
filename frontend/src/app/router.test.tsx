import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { makeAuthClient, makeExchangeApi, makeRequest, makeRequestsApi, makeUser } from "@test/factories";
import { AuthStore } from "@/features/auth";
import { ExchangeStore } from "@/entities/exchange";
import { RequestsStore, type PartnerRequest } from "@/entities/request";
import { App } from "./App";
import { routes } from "./router";

// The real routes, layout and guard in a memory router; only the stores' back ends are fakes.
// Like main.tsx, it starts the auth store's session check (`init`) after rendering.
async function renderApp(route: string, signedIn: boolean, existing: PartnerRequest[] = []) {
  const authClient = makeAuthClient(signedIn ? makeUser({ email: "ada@example.com" }) : null);
  const auth = new AuthStore(authClient, { logoutUrl: "https://auth.example/logout" });
  const api = makeRequestsApi();
  api.list.mockResolvedValue(existing);
  const requests = new RequestsStore(api);
  const exchange = new ExchangeStore(makeExchangeApi());
  const router = createMemoryRouter(routes, { initialEntries: [route] });

  render(<App stores={{ auth, requests, exchange }} router={router} />);
  await act(() => auth.init());
  return { authClient };
}

describe("app routes", () => {
  it("shows the sign-in page with one button to a visitor who is not signed in", async () => {
    await renderApp("/", false);

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
    // Nothing of the protected page, and no sign-out button in the header.
    expect(screen.queryByRole("heading", { name: "Requests" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("remembers the requested page for after the sign-in", async () => {
    const { authClient } = await renderApp("/requests/new", false);

    await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));

    expect(authClient.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: "/requests/new" } });
  });

  it("shows the list and the signed-in e-mail to a signed-in user", async () => {
    await renderApp("/", true, [makeRequest({ subject: "Visible subject" })]);

    expect(await screen.findByRole("link", { name: "Visible subject" })).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("shows a not-found page for an unknown URL", async () => {
    await renderApp("/no/such/page", true);

    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
  });
});
