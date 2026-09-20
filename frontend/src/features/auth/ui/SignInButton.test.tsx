import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeAuthClient } from "@test/factories";
import { renderWithProviders } from "@test/render";
import { AuthStore } from "../model/AuthStore";
import { SignInButton } from "./SignInButton";

function makeStore() {
  const client = makeAuthClient();
  return { client, auth: new AuthStore(client, { logoutUrl: "https://auth.example/logout" }) };
}

// The browser tells a page that it was restored from the back/forward cache with a
// `pageshow` event whose `persisted` flag is true.
function pageShow(persisted: boolean) {
  act(() => {
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));
  });
}

describe("SignInButton", () => {
  it("starts the sign-in with the page to come back to, and shows a pending state", async () => {
    const { client, auth } = makeStore();
    // The browser leaves for the hosted UI, so this promise never settles.
    client.signinRedirect.mockReturnValue(new Promise<void>(() => {}));
    const { user } = renderWithProviders(<SignInButton returnTo="/requests/new" />, { auth });

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(client.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: "/requests/new" } });
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  });

  it("is usable again when the page is restored from the back/forward cache", async () => {
    const { client, auth } = makeStore();
    client.signinRedirect.mockReturnValue(new Promise<void>(() => {}));
    const { user } = renderWithProviders(<SignInButton />, { auth });
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();

    pageShow(true);

    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("stays pending on an ordinary page show", async () => {
    const { client, auth } = makeStore();
    client.signinRedirect.mockReturnValue(new Promise<void>(() => {}));
    const { user } = renderWithProviders(<SignInButton />, { auth });
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    pageShow(false);

    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  });

  it("shows an error and enables the button again when the sign-in cannot start", async () => {
    const { client, auth } = makeStore();
    client.signinRedirect.mockRejectedValue(new Error("discovery failed"));
    const { user } = renderWithProviders(<SignInButton />, { auth });

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });
});
