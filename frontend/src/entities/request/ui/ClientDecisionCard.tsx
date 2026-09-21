import { useId } from "react";
import { formatDateTime } from "@/shared/lib";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card";
import { isAwaitingDecision } from "../model/status";
import type { PartnerRequest } from "../model/types";
import { ClientDecisionBadge } from "./ClientDecisionBadge";

// What the client did with the delivered message. It shows a decision whenever there is one,
// whatever the delivery status is (the webhook accepts it for any request). Without one, it
// only speaks for a delivered request that is waiting; for the others it renders nothing, as
// a "waiting" line under a request that was never delivered would only confuse.
export function ClientDecisionCard({ request }: { request: Pick<PartnerRequest, "status" | "clientDecision"> }) {
  const titleId = useId();
  const decision = request.clientDecision;

  if (decision === undefined && !isAwaitingDecision(request)) return null;

  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle id={titleId} role="heading" aria-level={2} className="text-lg">
          Client decision
        </CardTitle>
        <CardDescription>What the client did with the delivered message.</CardDescription>
      </CardHeader>
      {/* A polite live region: the page keeps asking while it waits, so a screen reader
          user is told when the decision arrives. Nothing is announced on the first render. */}
      <CardContent aria-live="polite">
        {decision === undefined ? (
          // Calm on purpose: not an error, no spinner and no deadline. Nothing is overdue
          // when the client simply has not acted yet.
          <p className="text-muted-foreground">Waiting for the client's decision. It can arrive at any time.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <ClientDecisionBadge decision={decision.decision} />
              <span className="text-muted-foreground">
                on <time dateTime={decision.at}>{formatDateTime(decision.at)}</time>
              </span>
            </div>
            {decision.reason !== undefined && decision.reason !== "" && (
              <div className="min-w-0 space-y-1">
                <p className="font-medium">Reason given by the client</p>
                {/* Text written by a third party: a plain text node, so React escapes it and
                    markup or a link in it stays literal characters. Never put it into
                    dangerouslySetInnerHTML, an href or a src. `wrap-anywhere` breaks a long
                    token with no spaces, so it cannot widen the page; `whitespace-pre-wrap`
                    keeps the line breaks the client wrote. */}
                <p className="wrap-anywhere whitespace-pre-wrap">{decision.reason}</p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
