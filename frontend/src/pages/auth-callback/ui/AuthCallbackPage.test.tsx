import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { makeAuthClient, makeUser } from "@test/factories";
import { renderWithProviders } from "@test/render";
import { AuthStore } from "@/features/auth";
import { AuthCallbackPage } from "./AuthCallbackPage";

// Opens /auth/callback the way Cognito's redirect does. `client` is the fake UserManager,
// already told what the code exchange should answer.
function renderCallback(client: ReturnType<typeof makeAuthClient>) {
  const auth = new AuthStore(client, { logoutUrl: "https://auth.example/logout" });
  return renderWithProviders(
    <Routes>
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      <Route path="/requests/:id" element={<p>Details page</p>} />
    </Routes>,
    { auth, route: "/auth/callback?code=abc&state=xyz" },
  );
}

describe("AuthCallbackPage", () => {
  it("completes the sign-in and continues at the page that was requested before", async () => {
    const client = makeAuthClient();
    client.signinRedirectCallback.mockResolvedValue(makeUser({ returnTo: "/requests/42" }));

    renderCallback(client);

    expect(await screen.findByText("Details page")).toBeInTheDocument();
    expect(client.signinRedirectCallback).toHaveBeenCalledOnce();
  });

  it("shows a loading state while the code is being exchanged", () => {
    const client = makeAuthClient();
    client.signinRedirectCallback.mockReturnValue(new Promise(() => undefined));

    renderCallback(client);

    expect(screen.getByRole("status", { name: "Signing you in" })).toBeInTheDocument();
  });

  it("shows a readable error state with a way to try again when the sign-in fails", async () => {
    const client = makeAuthClient();
    client.signinRedirectCallback.mockRejectedValue(new Error("access_denied"));

    renderCallback(client);

    expect(await screen.findByRole("heading", { name: "Sign-in failed" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("access_denied");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});
