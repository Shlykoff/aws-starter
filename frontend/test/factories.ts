import { User } from "oidc-client-ts";
import { vi } from "vitest";
import type { AuthClient } from "@/features/auth";
import type { PartnerRequest, RequestsApi } from "@/entities/request";

// Fake data only. A User with a valid one-hour access token unless overridden.
export function makeUser(
  overrides: { expiresInSeconds?: number; refreshToken?: string; returnTo?: string; email?: string } = {},
): User {
  const { expiresInSeconds = 3600, refreshToken, returnTo, email = "user@example.com" } = overrides;
  const now = Math.floor(Date.now() / 1000);
  return new User({
    access_token: "test-access-token",
    token_type: "Bearer",
    refresh_token: refreshToken,
    expires_at: now + expiresInSeconds,
    profile: { sub: "user-1", email, iss: "https://issuer.example", aud: "client-1", exp: now + 3600, iat: now },
    userState: returnTo === undefined ? undefined : { returnTo },
  });
}

// A stand-in for oidc-client-ts's UserManager: it stores nothing, opens no page and makes
// no request. Each method is a spy, so tests can also check how it was called.
export function makeAuthClient(user: User | null = null) {
  let current = user;
  return {
    getUser: vi.fn<AuthClient["getUser"]>(() => Promise.resolve(current)),
    signinRedirect: vi.fn<AuthClient["signinRedirect"]>(() => Promise.resolve()),
    signinRedirectCallback: vi.fn<AuthClient["signinRedirectCallback"]>(() =>
      Promise.reject(new Error("signinRedirectCallback: no result set by the test")),
    ),
    signinSilent: vi.fn<AuthClient["signinSilent"]>(() => Promise.resolve(null)),
    removeUser: vi.fn<AuthClient["removeUser"]>(() => {
      current = null;
      return Promise.resolve();
    }),
  };
}

let counter = 0;
export function makeRequest(overrides: Partial<PartnerRequest> = {}): PartnerRequest {
  counter += 1;
  // Ids that sort by creation time, like real ULIDs.
  const id = `01J00000000000000000000${String(counter).padStart(3, "0")}`;
  return {
    id,
    partner: "Acme Logistics",
    subject: `Delivery schedule ${counter}`,
    body: "Please confirm the schedule for next week.",
    status: "created",
    createdAt: "2025-01-31T09:05:00.000Z",
    ...overrides,
  };
}

export function makeRequestsApi() {
  return {
    list: vi.fn<RequestsApi["list"]>(() => Promise.resolve([])),
    get: vi.fn<RequestsApi["get"]>(() => Promise.reject(new Error("get: no result set by the test"))),
    create: vi.fn<RequestsApi["create"]>(() => Promise.reject(new Error("create: no result set by the test"))),
  };
}
