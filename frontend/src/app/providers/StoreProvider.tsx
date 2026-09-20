import type { ReactNode } from "react";
import { AuthStoreProvider } from "@/features/auth";
import { RequestsStoreProvider } from "@/entities/request";
import type { RootStore } from "./root-store";

// Puts every store into React context. Each slice owns its own context and hook
// (useAuthStore, useRequestsStore), so pages and features never import from this layer.
export function StoreProvider({ stores, children }: { stores: RootStore; children: ReactNode }) {
  return (
    <AuthStoreProvider store={stores.auth}>
      <RequestsStoreProvider store={stores.requests}>{children}</RequestsStoreProvider>
    </AuthStoreProvider>
  );
}
