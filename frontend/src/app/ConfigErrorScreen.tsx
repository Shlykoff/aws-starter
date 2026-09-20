import type { ConfigProblem } from "@/shared/config";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";

// Shown instead of the app when the build/environment is missing configuration, so a
// mistake in .env.local reads as a clear message and not as a blank page.
export function ConfigErrorScreen({ problems }: { problems: ConfigProblem[] }) {
  return (
    <main className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold">The app is not configured</h1>
      <Alert variant="destructive">
        <AlertTitle>Fix these environment variables</AlertTitle>
        <AlertDescription>
          <ul className="list-disc space-y-1 pl-5">
            {problems.map((problem) => (
              <li key={problem.name}>
                <code>{problem.name}</code> {problem.message}
              </li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
      <p className="text-sm text-muted-foreground">
        Copy <code>frontend/.env.example</code> to <code>frontend/.env.local</code>, fill in the values from{" "}
        <code>terraform output</code> and restart <code>yarn dev</code>.
      </p>
    </main>
  );
}
