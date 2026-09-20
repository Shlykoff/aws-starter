import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { makeAuthClient, makeUser } from "@test/factories";
import { renderWithProviders } from "@test/render";
import { AuthStore } from "../model/AuthStore";
import { RequireAuth } from "./RequireAuth";

// The guard as the router uses it: a layout route with the protected page below it.
const guarded = (
  <Routes>
    <Route element={<RequireAuth fallback={<p>Please sign in</p>} />}>
      <Route path="/" element={<p>Secret page</p>} />
    </Route>
  </Routes>
);

function makeStore(user = makeUser()) {
  return new AuthStore(makeAuthClient(user), { logoutUrl: "https://auth.example/logout" });
}

describe("RequireAuth", () => {
  it("shows a loading state until the stored session has been checked", () => {
    renderWithProviders(guarded, { auth: makeStore() });

    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.queryByText("Secret page")).not.toBeInTheDocument();
  });

  it("shows the fallback when nobody is signed in", async () => {
    const auth = makeStore();
    await auth.handleUnauthorized();

    renderWithProviders(guarded, { auth });

    expect(screen.getByText("Please sign in")).toBeInTheDocument();
    expect(screen.queryByText("Secret page")).not.toBeInTheDocument();
  });

  it("shows the protected page when signed in", async () => {
    const auth = makeStore();
    await auth.init();

    renderWithProviders(guarded, { auth });

    expect(screen.getByText("Secret page")).toBeInTheDocument();
  });

  it("switches to the fallback when the session ends while the page is open", async () => {
    const auth = makeStore();
    await auth.init();
    renderWithProviders(guarded, { auth });
    expect(screen.getByText("Secret page")).toBeInTheDocument();

    await act(async () => {
      await auth.handleUnauthorized();
    });

    expect(screen.getByText("Please sign in")).toBeInTheDocument();
  });
});
