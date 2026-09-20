import { createContext, useContext, type ReactNode } from "react";
import type { RequestsStore } from "./RequestsStore";

// The store is created once in the app layer and handed down through React context.
// The context lives in this slice, not in the app layer, because pages and features
// import the hook and they may only import from layers below them.
const RequestsStoreContext = createContext<RequestsStore | null>(null);

export function RequestsStoreProvider({ store, children }: { store: RequestsStore; children: ReactNode }) {
  return <RequestsStoreContext value={store}>{children}</RequestsStoreContext>;
}

export function useRequestsStore(): RequestsStore {
  const store = useContext(RequestsStoreContext);
  if (!store) throw new Error("useRequestsStore must be used inside <RequestsStoreProvider>");
  return store;
}
