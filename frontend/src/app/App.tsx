import { RouterProvider } from "react-router/dom";
import type { createAppRouter } from "./router";
import { StoreProvider } from "./providers/StoreProvider";
import type { RootStore } from "./providers/root-store";

export function App({ stores, router }: { stores: RootStore; router: ReturnType<typeof createAppRouter> }) {
  return (
    <StoreProvider stores={stores}>
      <RouterProvider router={router} />
    </StoreProvider>
  );
}
