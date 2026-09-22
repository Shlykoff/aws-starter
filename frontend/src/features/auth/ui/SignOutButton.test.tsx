import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeAuthClient, makeUser } from "@test/factories";
import { renderWithProviders } from "@test/render";
import { AuthStore } from "../model/AuthStore";
import { SignOutButton } from "./SignOutButton";

const LOGOUT_URL = "https://auth.example/logout";

function makeStore() {
  const client = makeAuthClient(makeUser());
  const navigate = vi.fn<(url: string) => void>();
  return { client, navigate, auth: new AuthStore(client, { logoutUrl: LOGOUT_URL, navigate }) };
}

describe("SignOutButton", () => {
  it("shows the sign-out label", () => {
    const { auth } = makeStore();
    renderWithProviders(<SignOutButton />, { auth });

    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("forgets the session and sends the browser to the hosted UI's logout page when clicked", async () => {
    const { client, navigate, auth } = makeStore();
    const { user } = renderWithProviders(<SignOutButton />, { auth });

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(client.removeUser).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(LOGOUT_URL);
  });
});
