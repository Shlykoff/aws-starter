import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeAuthClient, makeUser } from "@test/factories";
import { renderWithProviders } from "@test/render";
import { AuthStore } from "@/features/auth";
import { AppHeader } from "./AppHeader";

function makeStore(user: ReturnType<typeof makeUser> | null = null) {
  return new AuthStore(makeAuthClient(user), { logoutUrl: "https://auth.example/logout" });
}

describe("AppHeader", () => {
  it("always links the app name home", () => {
    renderWithProviders(<AppHeader />, { auth: makeStore() });

    expect(screen.getByRole("link", { name: "Partner requests" })).toHaveAttribute("href", "/");
  });

  it("shows the signed-in user's e-mail and the sign-out control", async () => {
    const auth = makeStore(makeUser({ email: "reviewer@example.com" }));
    await auth.init();

    renderWithProviders(<AppHeader />, { auth });

    expect(screen.getByText("reviewer@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("hides the e-mail and sign-out control while nobody is signed in", async () => {
    const auth = makeStore();
    await auth.handleUnauthorized();

    renderWithProviders(<AppHeader />, { auth });

    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("hides the e-mail and sign-out control before the stored session has been checked", () => {
    renderWithProviders(<AppHeader />, { auth: makeStore() });

    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });
});
