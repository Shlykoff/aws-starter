import { Link } from "react-router";
import { useDocumentTitle } from "@/shared/lib";
import { Button } from "@/shared/ui/button";

// For URLs that match no route.
export function NotFoundPage() {
  useDocumentTitle("Page not found");
  return (
    <div className="space-y-4 pt-8 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground">There is nothing at this address.</p>
      <Button asChild variant="outline">
        <Link to="/">Back to requests</Link>
      </Button>
    </div>
  );
}
