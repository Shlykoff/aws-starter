import { User } from "oidc-client-ts";
import { vi } from "vitest";
import type { AuthClient } from "@/features/auth";
import type { Exchange, ExchangeApi } from "@/entities/exchange";
import type { ClientDecision, PartnerRequest, RequestsApi } from "@/entities/request";

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
    subject: `Delivery schedule ${counter}`,
    body: "Please confirm the schedule for next week.",
    status: "created",
    createdAt: "2025-01-31T09:05:00.000Z",
    ...overrides,
  };
}

// An approval without a reason. Pass `clientDecision: makeClientDecision(...)` to makeRequest to
// get a request the client has answered; a request without the field is still waiting.
export function makeClientDecision(overrides: Partial<ClientDecision> = {}): ClientDecision {
  return {
    decision: "Approved",
    at: "2025-02-03T14:30:00.000Z",
    receivedAt: "2025-02-03T14:30:02.000Z",
    ...overrides,
  };
}

export function makeRequestsApi() {
  return {
    list: vi.fn<RequestsApi["list"]>(() => Promise.resolve([])),
    get: vi.fn<RequestsApi["get"]>(() => Promise.reject(new Error("get: no result set by the test"))),
    create: vi.fn<RequestsApi["create"]>(() => Promise.reject(new Error("create: no result set by the test"))),
    retry: vi.fn<RequestsApi["retry"]>(() => Promise.reject(new Error("retry: no result set by the test"))),
  };
}

// A delivered exchange with fake data: the message we sent and the partner's "Accepted".
export function makeExchange(overrides: Partial<Exchange> = {}): Exchange {
  return {
    attempt: 1,
    at: "2025-01-31T09:05:07.000Z",
    outcome: "delivered",
    request: {
      xml: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Submission xmlns="urn:aws-starter:submission:v1" version="1">',
        "  <Header>",
        "    <MessageId>01J00000000000000000000001</MessageId>",
        "  </Header>",
        "</Submission>",
      ].join("\n"),
      valid: true,
      problems: [],
    },
    reply: {
      httpStatus: 200,
      xml: '<Reply xmlns="urn:aws-starter:reply:v1" version="1"><Result><Status>Accepted</Status></Result></Reply>',
      valid: true,
      status: "Accepted",
    },
    ...overrides,
  };
}

// A promise that a test settles by hand, to look at the screen while a call is still running.
export function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// By default the request has not been tried yet (the API answers 404), which is the calm
// "nothing to show" case, so a test that does not care about the exchange sees no error.
export function makeExchangeApi() {
  return {
    // The default answer is null (a 204): the request has no delivery attempt yet.
    get: vi.fn<ExchangeApi["get"]>(() => Promise.resolve(null)),
  };
}
