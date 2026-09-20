import { afterEach, describe, expect, it } from "vitest";
import { makeUser } from "@test/factories";
import type { AppConfig } from "@/shared/config";
import { createAuthStore } from "./createAuthStore";

const config: AppConfig = {
  region: "eu-north-1",
  userPoolId: "eu-north-1_EXAMPLE",
  clientId: "client-1",
  hostedUiUrl: "https://example.auth.eu-north-1.amazoncognito.com",
  apiUrl: "https://api.example.com",
};

// Where oidc-client-ts keeps the signed-in user: "oidc.user:<authority>:<client id>".
const USER_KEY = "oidc.user:https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_EXAMPLE:client-1";

afterEach(() => {
  sessionStorage.clear();
});

// These use the real oidc-client-ts UserManager (no network: nothing here starts a sign-in).
describe("createAuthStore", () => {
  it("starts signed out when sessionStorage holds no session", async () => {
    const store = createAuthStore(config);

    await store.init();

    expect(store.status).toBe("anonymous");
  });

  it("restores the session from sessionStorage, under the key for this pool and client", async () => {
    sessionStorage.setItem(USER_KEY, makeUser({ email: "ada@example.com" }).toStorageString());
    const store = createAuthStore(config);

    await store.init();

    expect(store.status).toBe("authenticated");
    expect(store.email).toBe("ada@example.com");
    await expect(store.getAccessToken()).resolves.toBe("test-access-token");
  });

  it("forgets the session when a 401 says the token is not accepted", async () => {
    sessionStorage.setItem(USER_KEY, makeUser().toStorageString());
    const store = createAuthStore(config);
    await store.init();

    await store.handleUnauthorized();

    expect(sessionStorage.getItem(USER_KEY)).toBeNull();
    expect(store.status).toBe("anonymous");
  });
});
