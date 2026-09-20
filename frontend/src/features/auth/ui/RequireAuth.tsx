import type { ReactNode } from "react";
import { Outlet } from "react-router";
import { observer } from "mobx-react-lite";
import { Skeleton } from "@/shared/ui/skeleton";
import { useAuthStore } from "../model/store-context";

// Route guard, used as a layout route: everything nested below it needs a signed-in user.
// `fallback` (the sign-in page) is passed in by the app layer because a feature may not
// import from the pages layer.
export const RequireAuth = observer(function RequireAuth({ fallback }: { fallback: ReactNode }) {
  const auth = useAuthStore();

  if (auth.status === "loading") {
    return (
      <div role="status" aria-label="Loading" className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (auth.status === "anonymous") return fallback;
  return <Outlet />;
});
