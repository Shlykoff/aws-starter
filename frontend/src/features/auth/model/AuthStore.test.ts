import { describe, expect, it, vi } from "vitest";
import { makeAuthClient, makeUser } from "@test/factories";
import { AuthStore, readReturnPath } from "./AuthStore";

const LOGOUT_URL = "https://auth.example/logout?client_id=abc&logout_uri=http%3A%2F%2Flocalhost%3A5173%2F";

function setup(user = makeUser()) {
  const client = makeAuthClient(user);
  const navigate = vi.fn<(url: string) => void>();
  const store = new AuthStore(client, { logoutUrl: LOGOUT_URL, navigate });
  return { client, navigate, store };
}

describe("AuthStore.init", () => {
  it("starts in the loading state", () => {
    const { store } = setup();

    expect(store.status).toBe("loading");
  });

  it("restores a stored session", async () => {
    const { store } = setup(makeUser({ email: "ada@example.com" }));

    await store.init();

    expect(store.status).toBe("authenticated");
    expect(store.email).toBe("ada@example.com");
  });

  it("is anonymous when nothing is stored", async () => {
    const { client, store } = setup();
    client.getUser.mockResolvedValue(null);

    await store.init();

    expect(store.status).toBe("anonymous");
    expect(store.email).toBeNull();
  });

  it("renews an expired token with the refresh token instead of signing out", async () => {
    const expired = makeUser({ expiresInSeconds: -60, refreshToken: "refresh-1" });
    const renewed = makeUser({ email: "renewed@example.com" });
    const { client, store } = setup(expired);
    client.signinSilent.mockResolvedValue(renewed);

    await store.init();

    expect(client.signinSilent).toHaveBeenCalledOnce();
    expect(store.status).toBe("authenticated");
    expect(store.email).toBe("renewed@example.com");
  });

  it("is anonymous when the token is expired and there is no refresh token", async () => {
    const { client, store } = setup(makeUser({ expiresInSeconds: -60 }));

    await store.init();

    expect(client.signinSilent).not.toHaveBeenCalled();
    expect(store.status).toBe("anonymous");
  });

  it("is anonymous when renewing fails", async () => {
    const { client, store } = setup(makeUser({ expiresInSeconds: -60, refreshToken: "refresh-1" }));
    client.signinSilent.mockRejectedValue(new Error("refresh token expired"));

    await store.init();

    expect(store.status).toBe("anonymous");
  });
});

describe("AuthStore.signIn", () => {
  it("starts the redirect and remembers where to come back to", async () => {
    const { client, store } = setup();

    await store.signIn("/requests/42");

    expect(client.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: "/requests/42" } });
  });
});

describe("AuthStore.completeSignIn", () => {
  it("stores the user and resolves with the path saved before the redirect", async () => {
    const { client, store } = setup();
    client.signinRedirectCallback.mockResolvedValue(makeUser({ returnTo: "/requests/new", email: "ada@example.com" }));

    const returnTo = await store.completeSignIn();

    expect(returnTo).toBe("/requests/new");
    expect(store.status).toBe("authenticated");
    expect(store.email).toBe("ada@example.com");
  });

  it("rejects when Cognito reports an error and stays signed out", async () => {
    const { client, store } = setup();
    client.signinRedirectCallback.mockRejectedValue(new Error("access_denied"));

    await expect(store.completeSignIn()).rejects.toThrow("access_denied");
    expect(store.status).not.toBe("authenticated");
  });
});

describe("readReturnPath", () => {
  it("accepts paths on this site only", () => {
    expect(readReturnPath({ returnTo: "/requests/1?x=2" })).toBe("/requests/1?x=2");
    expect(readReturnPath({ returnTo: "https://evil.example/" })).toBe("/");
    expect(readReturnPath({ returnTo: "//evil.example/" })).toBe("/");
    expect(readReturnPath({ returnTo: 42 })).toBe("/");
    expect(readReturnPath(undefined)).toBe("/");
    expect(readReturnPath("/requests")).toBe("/");
  });
});

describe("AuthStore.signOut", () => {
  it("forgets the tokens, then opens the hosted UI logout URL", async () => {
    const { client, navigate, store } = setup();

    await store.signOut();

    expect(client.removeUser).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(LOGOUT_URL);
  });
});

describe("AuthStore.getAccessToken", () => {
  it("returns the access token of the current session", async () => {
    const { store } = setup();

    await expect(store.getAccessToken()).resolves.toBe("test-access-token");
  });

  it("returns null when there is no session or the token has expired", async () => {
    const { client, store } = setup(makeUser({ expiresInSeconds: -60 }));
    await expect(store.getAccessToken()).resolves.toBeNull();

    client.getUser.mockResolvedValue(null);
    await expect(store.getAccessToken()).resolves.toBeNull();
  });
});

describe("AuthStore.handleUnauthorized", () => {
  it("drops the session and remembers that it expired, without redirecting", async () => {
    const { client, navigate, store } = setup();
    await store.init();
    expect(store.status).toBe("authenticated");

    await store.handleUnauthorized();

    expect(client.removeUser).toHaveBeenCalledOnce();
    expect(store.status).toBe("anonymous");
    expect(store.user).toBeNull();
    expect(store.sessionExpired).toBe(true);
    expect(client.signinRedirect).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("clears the expired flag after the next sign-in", async () => {
    const { client, store } = setup();
    await store.handleUnauthorized();
    client.signinRedirectCallback.mockResolvedValue(makeUser());

    await store.completeSignIn();

    expect(store.sessionExpired).toBe(false);
  });
});
