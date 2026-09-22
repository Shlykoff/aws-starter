import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { observer } from "mobx-react-lite";
import { ArrowLeft, CircleAlert } from "lucide-react";
import { ExchangePanel, useExchangeStore } from "@/entities/exchange";
import {
  ClientDecisionCard,
  DECISION_POLL_INTERVAL_MS,
  getStatusExplanation,
  isAwaitingDecision,
  isTerminalStatus,
  type PartnerRequest,
  RequestStatusBadge,
  STATUS_POLL_INTERVAL_MS,
  useRequestsStore,
} from "@/entities/request";
import { getErrorMessage } from "@/shared/api";
import { formatDateTime, useDocumentTitle, usePolling } from "@/shared/lib";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card";
import { Separator } from "@/shared/ui/separator";
import { Skeleton } from "@/shared/ui/skeleton";

// What the last press of "Send again" leaves to tell the user. Local state and not a store field:
// it is a message about one click on this screen, nobody else needs it. (The `retrying` flag is in
// the store: it must survive leaving the page and coming back while the call is still running.)
type RetryFeedback = { kind: "already-sent" } | { kind: "error"; message: string };

// Under the explanation of a failed request: the way out. Also draws the answer to the last press
// after the status has changed and the button is gone (the calm note), so it is not tied to `failed`.
const SendAgain = observer(function SendAgain({ request }: { request: PartnerRequest }) {
  const requests = useRequestsStore();
  const [feedback, setFeedback] = useState<RetryFeedback | null>(null);
  const retrying = requests.isRetrying(request.id);

  async function sendAgain() {
    setFeedback(null);
    try {
      const outcome = await requests.retry(request.id);
      // 409: somebody sent it again first (a double press, another tab). The store has read the
      // request again, so the page already shows what it is now.
      if (outcome === "not-retryable") setFeedback({ kind: "already-sent" });
    } catch (error) {
      setFeedback({ kind: "error", message: getErrorMessage(error) });
    }
  }

  return (
    <>
      {request.status === "failed" && (
        <div className="space-y-2">
          <Button onClick={() => void sendAgain()} disabled={retrying}>
            {retrying ? "Sending..." : "Send again"}
          </Button>
          <p className="text-sm text-muted-foreground">It goes through delivery again, with up to five attempts.</p>
        </div>
      )}
      {feedback?.kind === "already-sent" && (
        <p role="status" className="text-sm text-muted-foreground">
          This request was already sent again
        </p>
      )}
      {feedback?.kind === "error" && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Could not send the request again</AlertTitle>
          <AlertDescription>{feedback.message}</AlertDescription>
        </Alert>
      )}
    </>
  );
});

export const RequestDetailsPage = observer(function RequestDetailsPage() {
  // The route is /requests/:id, so `id` is always there; the fallback only satisfies the type.
  const { id = "" } = useParams();
  const requests = useRequestsStore();
  const exchanges = useExchangeStore();

  useEffect(() => {
    void requests.loadDetail(id);
    // The exchange is asked for at the same time, without waiting for the request: it is
    // not shown before the request is, and this saves a round trip on a direct link.
    void exchanges.load(id);
  }, [requests, exchanges, id]);

  const request = requests.findById(id);
  const detail = requests.detail?.id === id ? requests.detail : null;
  useDocumentTitle(request?.subject ?? "Request");

  // Keep refreshing while the request is created or queued; terminal statuses never change.
  // The exchange rides on the same tick, and not only on a status change: while the request
  // stays `queued` the worker may try again and again, and every attempt replaces the
  // record. The request is read first: for a final outcome the worker writes the record
  // before the status, so a terminal status always comes with the final record.
  const polling = request !== undefined && !isTerminalStatus(request.status);
  usePolling(
    async () => {
      await requests.refreshDetail(id);
      await exchanges.refresh(id);
    },
    STATUS_POLL_INTERVAL_MS,
    polling,
  );

  // A delivered request may still get the client's decision, minutes or months later (it is
  // independent of the delivery status). So a `sent` request without one is asked for again,
  // slowly, until a decision shows up. usePolling pauses in a hidden tab and refreshes at once
  // when the tab is visible again. Only the request is read: the exchange is final by now.
  // Never for `failed` and `rejected`: nothing was delivered, so nothing is expected. The two
  // polls are never on at the same time: `polling` needs a status that can still change and
  // this one needs `sent`.
  const awaitingDecision = request !== undefined && isAwaitingDecision(request);
  usePolling(() => requests.refreshDetail(id), DECISION_POLL_INTERVAL_MS, awaitingDecision);

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
            <time dateTime={request.createdAt}>{formatDateTime(request.createdAt)}</time>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Status</span>
            <RequestStatusBadge status={request.status} />
          </div>
          {explanation && <p className="text-sm">{explanation}</p>}
          {/* `key`: the feedback of one request must not follow the user to another one. */}
          <SendAgain key={request.id} request={request} />
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
      {/* The business outcome first, the technical detail (the exchange) after it. The card
          draws nothing when no decision is expected. */}
      {request && <ClientDecisionCard request={request} />}
      {/* Only for a request that exists: the exchange belongs to it. */}
      {/* While the request is created or queued (`polling`) the record shown is an earlier attempt. */}
      {request && (
        <ExchangePanel state={exchanges.stateFor(id)} onRetry={() => void exchanges.load(id)} earlierAttempt={polling} />
      )}
    </div>
  );
});
