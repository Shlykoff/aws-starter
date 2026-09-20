import { Link } from "react-router";
import { observer } from "mobx-react-lite";
import { SignOutButton, useAuthStore } from "@/features/auth";

// Top bar: app name (a link home), the signed-in e-mail and the sign-out button.
// The e-mail and button only show while signed in, so the same header also sits above the
// sign-in page.
export const AppHeader = observer(function AppHeader() {
  const auth = useAuthStore();

  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-14 w-full max-w-4xl items-center justify-between gap-4 px-4">
        <Link to="/" className="font-semibold">
          Partner requests
        </Link>
        {auth.status === "authenticated" && (
          <div className="flex min-w-0 items-center gap-3">
            {auth.email && (
              <span className="truncate text-sm text-muted-foreground" title={auth.email}>
                {auth.email}
              </span>
            )}
            <SignOutButton />
          </div>
        )}
      </div>
    </header>
  );
});
