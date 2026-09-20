import { useLocation } from "react-router";
import { observer } from "mobx-react-lite";
import { SignInButton, useAuthStore } from "@/features/auth";
import { useDocumentTitle } from "@/shared/lib";
import { Alert, AlertDescription } from "@/shared/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card";

// Shown by the route guard in place of a protected page. It renders at the URL that was
// asked for, so after signing in the visitor lands exactly there.
export const SignInPage = observer(function SignInPage() {
  useDocumentTitle("Sign in");
  const auth = useAuthStore();
  const location = useLocation();

  return (
    <div className="flex justify-center pt-8">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>Sign in</CardTitle>
          <CardDescription>Sign in to see and create your requests.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {auth.sessionExpired && (
            <Alert>
              <AlertDescription>Your session has expired. Please sign in again.</AlertDescription>
            </Alert>
          )}
          <SignInButton returnTo={`${location.pathname}${location.search}`} />
        </CardContent>
      </Card>
    </div>
  );
});
