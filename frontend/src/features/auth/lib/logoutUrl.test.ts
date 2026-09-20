import { describe, expect, it } from "vitest";
import { buildLogoutUrl } from "./logoutUrl";

describe("buildLogoutUrl", () => {
  it("points at the hosted UI /logout with the client id and the sign-out URL (trailing slash)", () => {
    const url = new URL(buildLogoutUrl("https://example.auth.eu-north-1.amazoncognito.com", "abc123", "http://localhost:5173"));

    expect(url.origin + url.pathname).toBe("https://example.auth.eu-north-1.amazoncognito.com/logout");
    expect(url.searchParams.get("client_id")).toBe("abc123");
    expect(url.searchParams.get("logout_uri")).toBe("http://localhost:5173/");
  });
});
