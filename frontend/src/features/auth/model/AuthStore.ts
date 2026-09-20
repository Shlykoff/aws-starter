import { makeAutoObservable, observableRef, runInAction } from "mobx";
import type { User, UserManager } from "oidc-client-ts";

// The part of oidc-client-ts's UserManager that the store uses. Naming it makes the
// dependency explicit and lets tests pass a small fake instead of a real UserManager.
export type AuthClient = Pick<
  UserManager,
  "getUser" | "signinRedirect" | "signinRedirectCallback" | "signinSilent" | "removeUser"
>;

// loading: we have not looked at the stored session yet (first moments after page load)
export type AuthStatus = "loading" | "authenticated" | "anonymous";

export interface AuthStoreOptions {
  // Cognito hosted UI logout URL, ready to open (see lib/logoutUrl.ts).
  logoutUrl: string;
  // Full page navigation. A parameter so tests do not have to navigate jsdom.
  navigate?: (url: string) => void;
}

// After sign-in we send the user back to where they were. That path travels through
// Cognito inside the OIDC `state` and is only accepted if it is a path on this site
// ("/x", not "//evil.example" or "https://..."), so the redirect cannot leave the app.
export function readReturnPath(state: unknown): string {
  const returnTo = typeof state === "object" && state !== null && "returnTo" in state ? state.returnTo : undefined;
  return typeof returnTo === "string" && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
}

// Why an observable store and not component state: "who is signed in" is read by the route
// guard, the header and the API client at once, and it changes from outside React (a 401
// from the API, a token renewed in the background).
export class AuthStore {
  status: AuthStatus = "loading";
  user: User | null = null;
  // True after the API rejected our token: the sign-in page then explains what happened.
  sessionExpired = false;

  private readonly navigate: (url: string) => void;

  constructor(
    private readonly client: AuthClient,
    private readonly options: AuthStoreOptions,
  ) {
    this.navigate = options.navigate ?? ((url) => window.location.assign(url));
    makeAutoObservable<AuthStore, "client" | "options" | "navigate">(this, {
      client: false,
      options: false,
      navigate: false,
      // The User object belongs to oidc-client-ts; MobX should only notice when it is replaced.
      user: observableRef,
    });
  }

  get email(): string | null {
    const email = this.user?.profile.email;
    return typeof email === "string" ? email : null;
  }

  // Called once at startup: is there a session left in sessionStorage from before a reload?
  async init(): Promise<void> {
    let user: User | null = null;
    try {
      user = await this.client.getUser();
      // The access token lives one hour. If it ran out while the tab was closed or asleep
      // but a refresh token is still there, get a new one instead of asking the user to sign in.
      if (user?.expired && user.refresh_token) user = await this.client.signinSilent();
      if (user?.expired) user = null;
    } catch {
      // An unreadable stored session or a failed renewal simply means "signed out".
      user = null;
    }
    runInAction(() => {
      // A sign-in that finished while we were reading must not be overwritten.
      if (this.status === "loading") this.setUser(user);
    });
  }

  // Redirects the browser to the Cognito hosted UI (authorization code flow with PKCE).
  async signIn(returnTo = "/"): Promise<void> {
    await this.client.signinRedirect({ state: { returnTo } });
  }

  // Runs on /auth/callback: exchanges the `code` in the URL for tokens. Resolves with the
  // path to continue at. Rejects when Cognito reported an error or the state is unknown.
  async completeSignIn(): Promise<string> {
    const user = await this.client.signinRedirectCallback();
    runInAction(() => this.setUser(user));
    return readReturnPath(user.state);
  }

  // Cognito's logout endpoint takes its own parameters (`client_id`, `logout_uri`), not the
  // standard OIDC ones, so we do it in two steps: forget the tokens here, then let the
  // hosted UI end its own session and bring us back.
  async signOut(): Promise<void> {
    await this.client.removeUser();
    this.navigate(this.options.logoutUrl);
  }

  // The API access token, or null if there is none or it has expired. Read from the
  // client on every call so a token renewed in the background is used automatically.
  async getAccessToken(): Promise<string | null> {
    const user = await this.client.getUser();
    return user && !user.expired ? user.access_token : null;
  }

  // The API answered 401. Drop the session and show the sign-in page. We deliberately do
  // not redirect to Cognito right away: if the API kept rejecting a valid Cognito login
  // (a misconfiguration), the hosted UI would bounce us straight back and loop forever.
  async handleUnauthorized(): Promise<void> {
    await this.client.removeUser();
    runInAction(() => {
      this.setUser(null);
      this.sessionExpired = true;
    });
  }

  private setUser(user: User | null): void {
    this.user = user;
    this.status = user ? "authenticated" : "anonymous";
    if (user) this.sessionExpired = false;
  }
}
