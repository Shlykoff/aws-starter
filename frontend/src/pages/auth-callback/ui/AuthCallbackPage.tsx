import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { SignInButton, useAuthStore } from "@/features/auth";
import { useDocumentTitle } from "@/shared/lib";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card";
import { Skeleton } from "@/shared/ui/skeleton";

// Cognito sends the browser back here with `?code=...&state=...` (or `?error=...`).
// This page finishes the sign-in and then moves on to the page the user came from.
export function AuthCallbackPage() {
  useDocumentTitle("Signing in");
  const auth = useAuthStore();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // React StrictMode runs effects twice in development, but an authorization code can
    // be exchanged only once: the second attempt would fail and show a made-up error.
    if (started.current) return;
    started.current = true;

    auth
      .completeSignIn()
      .then((returnTo) => navigate(returnTo, { replace: true }))
      .catch((e: unknown) => {
        // oidc-client-ts errors carry Cognito's own text (e.g. "access_denied", or
        // "No matching state found in storage" when the page is opened by hand).
        setError(e instanceof Error ? e.message : "Unknown error");
      });
  }, [auth, navigate]);

  if (error) {
    return (
      <Card className="mx-auto w-full max-w-sm">
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>
            Sign-in failed
          </CardTitle>
          <CardDescription>We could not complete the sign-in.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertTitle>What went wrong</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
          <SignInButton returnTo="/" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div role="status" aria-label="Signing you in" className="space-y-4">
      <p className="text-muted-foreground">Signing you in…</p>
      <Skeleton className="h-8 w-48" />
    </div>
  );
}
