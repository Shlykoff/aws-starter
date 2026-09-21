import { useId, type ReactNode } from "react";
import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { formatDateTime } from "@/shared/lib";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card";
import { Skeleton } from "@/shared/ui/skeleton";
import type { ExchangeState } from "../model/ExchangeStore";
import type { Exchange } from "../model/types";
import { ExchangeOutcomeBadge, getOutcomeExplanation } from "./ExchangeOutcomeBadge";
import { XmlBlock } from "./XmlBlock";

// "Valid against submission.xsd: yes". The icon is decoration; the words say it.
function ValidityLine({ schema, valid }: { schema: string; valid: boolean }) {
  const Icon = valid ? CircleCheck : CircleX;
  return (
    <p className="flex items-center gap-1.5 text-sm">
      <Icon
        aria-hidden="true"
        className={`size-4 shrink-0 ${valid ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
      />
      <span>{`Valid against ${schema}: ${valid ? "yes" : "no"}`}</span>
    </p>
  );
}

// What was wrong with our message: the element and the rule, never the value.
function ProblemList({ problems }: { problems: Exchange["request"]["problems"] }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">Problems found</p>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {problems.map((problem, index) => (
          // No id in the data and the list never changes while shown: the index is a fine key.
          <li key={index} className="break-words">
            <code>{problem.element}</code> — {problem.rule}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SentBlock({ exchange }: { exchange: Exchange }) {
  const { outcome, request } = exchange;
  return (
    <div className="min-w-0 space-y-3">
      <h3 className="font-medium">Sent</h3>
      {outcome === "unrepresentable" ? (
        // The record has an empty `xml` here: explain instead of showing an empty box.
        <p className="text-sm text-muted-foreground">
          There is no XML to show: the message could not be built, so nothing was sent.
        </p>
      ) : (
        <>
          <ValidityLine schema="submission.xsd" valid={request.valid} />
          {request.problems.length > 0 && <ProblemList problems={request.problems} />}
          <XmlBlock label="Request XML" xml={request.xml} />
        </>
      )}
    </div>
  );
}

function ReceivedBlock({ exchange }: { exchange: Exchange }) {
  const { outcome, reply } = exchange;
  // Two outcomes end before anybody is called: there is no answer because nothing was sent.
  const notSent = outcome === "invalid_request" || outcome === "unrepresentable";

  let body: ReactNode;
  if (reply === null) {
    body = (
      <p className="text-sm text-muted-foreground">
        {notSent
          ? "Nothing was sent, so there is no answer."
          : "No answer from the partner. The connection failed or timed out."}
      </p>
    );
  } else {
    body = (
      <>
        {/* `description` is text written by the partner: a text node, like the XML. */}
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">HTTP status</dt>
          <dd>{reply.httpStatus}</dd>
          {reply.status !== undefined && (
            <>
              <dt className="text-muted-foreground">Status</dt>
              <dd>{reply.status}</dd>
            </>
          )}
          {reply.code !== undefined && (
            <>
              <dt className="text-muted-foreground">Code</dt>
              <dd className="break-words">{reply.code}</dd>
            </>
          )}
          {reply.description !== undefined && (
            <>
              <dt className="text-muted-foreground">Description</dt>
              <dd className="break-words">{reply.description}</dd>
            </>
          )}
        </dl>
        {reply.xml === null ? (
          <p className="text-sm text-muted-foreground">The answer had no body.</p>
        ) : (
          <>
            <ValidityLine schema="reply.xsd" valid={reply.valid} />
            <XmlBlock label="Reply XML" xml={reply.xml} />
          </>
        )}
      </>
    );
  }

  return (
    <div className="min-w-0 space-y-3">
      <h3 className="font-medium">Received</h3>
      {body}
    </div>
  );
}

function ExchangeDetails({ exchange, earlierAttempt }: { exchange: Exchange; earlierAttempt: boolean }) {
  return (
    <>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <ExchangeOutcomeBadge outcome={exchange.outcome} />
          <span>Attempt {exchange.attempt}</span>
          <time dateTime={exchange.at} className="text-muted-foreground">
            {formatDateTime(exchange.at)}
          </time>
        </div>
        <p className="text-sm">{getOutcomeExplanation(exchange.outcome)}</p>
        {earlierAttempt && (
          <p className="text-sm text-muted-foreground">
            This is the earlier attempt; the new one replaces it when it has run.
          </p>
        )}
      </div>
      {/* One column on narrow screens, two side by side from `lg`. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <SentBlock exchange={exchange} />
        <ReceivedBlock exchange={exchange} />
      </div>
    </>
  );
}

// The exchange of one request: what our system sent to the partner and what came back.
// A plain view of the store's state (the page asks the store; this only draws), so it can
// be tested and previewed with a ready-made state. `null` means nothing was asked yet and
// looks like loading. `earlierAttempt`: the request is not finished, so the record shown is not the
// last word (the page knows the request's status, this entity does not).
export function ExchangePanel({
  state,
  onRetry,
  earlierAttempt = false,
}: {
  state: ExchangeState | null;
  onRetry: () => void;
  earlierAttempt?: boolean;
}) {
  const titleId = useId();

  let body: ReactNode;
  if (state === null || state.status === "loading") {
    body = (
      <div role="status" aria-label="Loading exchange" className="space-y-3">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  } else if (state.status === "empty") {
    // A 204 is normal while the request has not been tried yet, and for good once the record
    // has expired (S3 lifecycle, docs/api.md): calm, not an error.
    body = (
      <div className="space-y-1">
        <p className="font-medium">No delivery attempt to show</p>
        <p className="text-sm text-muted-foreground">
          The message has not been sent to the partner yet, or its record has expired (records are kept for 30 days).
          Once it is sent, the XML and the answer show up here.
        </p>
      </div>
    );
  } else if (state.status === "error") {
    body = (
      <Alert variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>Could not load the exchange</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{state.message}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else {
    body = <ExchangeDetails exchange={state.exchange} earlierAttempt={earlierAttempt} />;
  }

  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle id={titleId} role="heading" aria-level={2} className="text-lg">
          Exchange
        </CardTitle>
        <CardDescription>
          The latest delivery attempt: the XML we sent to the partner and the answer that came back.
        </CardDescription>
      </CardHeader>
      <CardContent className="gap-4">{body}</CardContent>
    </Card>
  );
}
