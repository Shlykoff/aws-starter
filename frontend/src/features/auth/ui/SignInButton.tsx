import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { getErrorMessage } from "@/shared/api";
import { Alert, AlertDescription } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { useAuthStore } from "../model/store-context";

// `returnTo`: the path to come back to after signing in (the page the visitor asked for).
export function SignInButton({ returnTo = "/" }: { returnTo?: string }) {
  const auth = useAuthStore();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The Back button on the hosted UI can restore this page from the browser's back/forward
  // cache exactly as it was left, with the button still "pending". `persisted` tells us
  // that this is such a restore, so the button is usable again.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setPending(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      // On success the browser leaves for Cognito, so there is nothing to reset afterwards.
      await auth.signIn(returnTo);
    } catch (e) {
      // e.g. Cognito's discovery document could not be fetched
      setError(getErrorMessage(e));
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <Button onClick={() => void handleClick()} disabled={pending} className="w-full">
        {pending && <LoaderCircle className="animate-spin" aria-hidden="true" />}
        Sign in
      </Button>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
