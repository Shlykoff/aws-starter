import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import { observer } from "mobx-react-lite";
import { CircleAlert, Inbox, Plus } from "lucide-react";
import {
  ClientDecisionBadge,
  getClientStatus,
  RequestStatusBadge,
  STATUS_POLL_INTERVAL_MS,
  useRequestsStore,
  type PartnerRequest,
} from "@/entities/request";
import { formatDateTime, useDocumentTitle, usePolling } from "@/shared/lib";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { Skeleton } from "@/shared/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/shared/ui/table";

function RequestsTable({ items }: { items: PartnerRequest[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Subject</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((request) => {
          const clientStatus = getClientStatus(request);
          return (
            <TableRow key={request.id}>
              <TableCell className="max-w-64 truncate font-medium">
                <Link to={`/requests/${request.id}`} className="underline-offset-4 hover:underline">
                  {request.subject}
                </Link>
              </TableCell>
              <TableCell>
                {/* The delivery status, and next to it the client's status: the decision, or
                    "Waiting" for a delivered request without one. None for the others. */}
                <div className="flex items-center gap-1.5">
                  <RequestStatusBadge status={request.status} />
                  {clientStatus && <ClientDecisionBadge clientStatus={clientStatus} />}
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                <time dateTime={request.createdAt}>{formatDateTime(request.createdAt)}</time>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading requests" className="space-y-3">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-12 text-center">
      <Inbox className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="font-medium">No requests yet</p>
      <p className="text-sm text-muted-foreground">Create your first request to see it here.</p>
      <Button asChild variant="outline" size="sm">
        <Link to="/requests/new">Create a request</Link>
      </Button>
    </div>
  );
}

export const RequestsListPage = observer(function RequestsListPage() {
  useDocumentTitle("Requests");
  const requests = useRequestsStore();

  // Load when the page opens. Cached items (e.g. one just created) stay visible meanwhile.
  useEffect(() => {
    void requests.loadList();
  }, [requests]);

  const { items, listState, listError } = requests;

  // Statuses change on the server after the request was created, so keep refreshing while
  // any listed request is not terminal yet. Not while the page's own load is running:
  // two list requests at once could answer in the wrong order.
  const polling = requests.hasPendingItems && listState !== "loading";
  usePolling(() => requests.refreshList(), STATUS_POLL_INTERVAL_MS, polling);

  let content: ReactNode;
  if (items.length > 0) content = <RequestsTable items={items} />;
  else if (listState === "ready") content = <EmptyState />;
  else if (listState === "error") content = null; // the error alert below says it all
  else content = <ListSkeleton />; // "idle" (before the first effect) or "loading"

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Requests</h1>
        <Button asChild>
          <Link to="/requests/new">
            <Plus aria-hidden="true" />
            New request
          </Link>
        </Button>
      </div>

      {listState === "error" && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Could not load the requests</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{listError}</p>
            <Button variant="outline" size="sm" onClick={() => void requests.loadList()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {content}
    </div>
  );
});
