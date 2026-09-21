import { createContext, useContext, type ReactNode } from "react";
import type { ExchangeStore } from "./ExchangeStore";

// Same arrangement as the request entity: the store is created once in the app layer and
// handed down through context; the context and its hook live in this slice so that pages
// import them from a layer below.
const ExchangeStoreContext = createContext<ExchangeStore | null>(null);

export function ExchangeStoreProvider({ store, children }: { store: ExchangeStore; children: ReactNode }) {
  return <ExchangeStoreContext value={store}>{children}</ExchangeStoreContext>;
}

export function useExchangeStore(): ExchangeStore {
  const store = useContext(ExchangeStoreContext);
  if (!store) throw new Error("useExchangeStore must be used inside <ExchangeStoreProvider>");
  return store;
}
