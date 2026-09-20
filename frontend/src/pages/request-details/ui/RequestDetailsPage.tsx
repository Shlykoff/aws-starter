import { useEffect, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { observer } from "mobx-react-lite";
import { ArrowLeft, CircleAlert } from "lucide-react";
import {
  getStatusExplanation,
  isTerminalStatus,
  RequestStatusBadge,
  STATUS_POLL_INTERVAL_MS,
  useRequestsStore,
} from "@/entities/request";
import { formatDateTime, useDocumentTitle, usePolling } from "@/shared/lib";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card";
import { Separator } from "@/shared/ui/separator";
import { Skeleton } from "@/shared/ui/skeleton";

export const RequestDetailsPage = observer(function RequestDetailsPage() {
  // The route is /requests/:id, so `id` is always there; the fallback only satisfies the type.
  const { id = "" } = useParams();
  const requests = useRequestsStore();

  useEffect(() => {
    void requests.loadDetail(id);
  }, [requests, id]);

  const request = requests.findById(id);
  const detail = requests.detail?.id === id ? requests.detail : null;
  useDocumentTitle(request?.subject ?? "Request");

  // Keep refreshing while the request is created or queued; terminal statuses never change.
  const polling = request !== undefined && !isTerminalStatus(request.status);
  usePolling(() => requests.refreshDetail(id), STATUS_POLL_INTERVAL_MS, polling);
  const explanation = request ? getStatusExplanation(request.status) : undefined;

  let content: ReactNode;
  if (request) {
    content = (
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={1} className="text-xl break-words">
            {request.subject}
          </CardTitle>
          <CardDescription>
            To {request.partner} ·{" "}
            <time dateTime={request.createdAt}>{formatDateTime(request.createdAt)}</time>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Status</span>
            <RequestStatusBadge status={request.status} />
          </div>
          {explanation && <p className="text-sm">{explanation}</p>}
          <Separator />
          <p className="text-sm break-words whitespace-pre-wrap">{request.body}</p>
        </CardContent>
      </Card>
    );
  } else if (detail?.status === "not-found") {
    content = (
      <Alert>
        <CircleAlert aria-hidden="true" />
        <AlertTitle>Request not found</AlertTitle>
        <AlertDescription>
          There is no request with this ID, or it belongs to someone else.
        </AlertDescription>
      </Alert>
    );
  } else if (detail?.status === "error") {
    content = (
      <Alert variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>Could not load the request</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{detail.message}</p>
          <Button variant="outline" size="sm" onClick={() => void requests.loadDetail(id)}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else {
    // Nothing known yet: before the first effect (no state) or while it loads.
    content = (
      <div role="status" aria-label="Loading request" className="space-y-3">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm">
        <Link to="/">
          <ArrowLeft aria-hidden="true" />
          All requests
        </Link>
      </Button>
      {content}
    </div>
  );
});
