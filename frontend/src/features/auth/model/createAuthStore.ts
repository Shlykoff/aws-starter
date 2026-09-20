import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import type { AppConfig } from "@/shared/config";
import { buildLogoutUrl } from "../lib/logoutUrl";
import { AuthStore } from "./AuthStore";

// Builds the real UserManager (oidc-client-ts) and wraps it in an AuthStore.
export function createAuthStore(config: AppConfig): AuthStore {
  const origin = window.location.origin;

  // Tokens are kept in sessionStorage. Trade-off: any script running on the page can read
  // them, so an XSS bug would leak them (the mitigation is not having XSS: React escapes
  // output, we add no third-party scripts). sessionStorage is cleared when the tab closes,
  // which limits how long they stay around, unlike localStorage. Keeping tokens only in
  // memory (lost on reload) or in a backend-for-frontend session cookie would be safer,
  // but both are out of scope for this project.
  const store = new WebStorageStateStore({ store: window.sessionStorage });

  const userManager = new UserManager({
    // Cognito publishes OIDC discovery (endpoints, signing keys) under this address.
    authority: `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`,
    client_id: config.clientId, // a public client: no client secret exists or is needed
    redirect_uri: `${origin}/auth/callback`,
    response_type: "code", // authorization code flow; oidc-client-ts adds PKCE (S256) itself
    scope: "openid email",
    // Renew shortly before the access token expires, using the refresh token.
    automaticSilentRenew: true,
    userStore: store,
    stateStore: store,
  });

  return new AuthStore(userManager, {
    logoutUrl: buildLogoutUrl(config.hostedUiUrl, config.clientId, origin),
  });
}
