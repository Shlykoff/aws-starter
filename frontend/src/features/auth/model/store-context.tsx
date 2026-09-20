import { createContext, useContext, type ReactNode } from "react";
import type { AuthStore } from "./AuthStore";

// Same idea as in the `request` entity: the context lives next to its store so the layers
// above can import the hook without the app layer having to be imported upwards.
const AuthStoreContext = createContext<AuthStore | null>(null);

export function AuthStoreProvider({ store, children }: { store: AuthStore; children: ReactNode }) {
  return <AuthStoreContext value={store}>{children}</AuthStoreContext>;
}

export function useAuthStore(): AuthStore {
  const store = useContext(AuthStoreContext);
  if (!store) throw new Error("useAuthStore must be used inside <AuthStoreProvider>");
  return store;
}
