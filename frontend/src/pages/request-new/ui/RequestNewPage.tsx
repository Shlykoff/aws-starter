import { useNavigate } from "react-router";
import { CreateRequestForm } from "@/features/create-request";
import { useDocumentTitle } from "@/shared/lib";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card";

export function RequestNewPage() {
  useDocumentTitle("New request");
  const navigate = useNavigate();

  return (
    <Card className="mx-auto w-full max-w-xl">
      <CardHeader>
        <CardTitle role="heading" aria-level={1}>
          New request
        </CardTitle>
        <CardDescription>All fields are required.</CardDescription>
      </CardHeader>
      <CardContent>
        {/* The store already holds the new request, so the details page opens without a fetch. */}
        <CreateRequestForm onCreated={(created) => void navigate(`/requests/${created.id}`)} />
      </CardContent>
    </Card>
  );
}
