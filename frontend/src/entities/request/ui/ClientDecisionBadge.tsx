import { Badge } from "@/shared/ui/badge";
import type { ClientStatus } from "../model/types";

// One look per client status. The word is always visible, so the meaning never depends on colour
// alone. Typed as Record<ClientStatus, ...>: a new decision in the API makes this table fail to
// compile until it gets a look. The tinted look (not the solid one of the `Sent` status badge)
// keeps the two apart when they stand side by side in a list row.
// `Declined` is amber, not red: it is a business answer, not an error of ours.
// `Waiting` is neutral (grey, dashed outline, no fill): nothing has happened yet, so it is
// neither good nor bad news, and the dashed line reads as "not filled in yet".
const STATUS_LOOK: Record<ClientStatus, { className: string; title: string }> = {
  Approved: {
    className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-300",
    title: "What the client did with the delivered message",
  },
  Declined: {
    className: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-300",
    title: "What the client did with the delivered message",
  },
  Waiting: {
    className: "border-dashed border-slate-400 bg-transparent text-slate-700 dark:border-slate-500 dark:text-slate-300",
    title: "The message was delivered; the client has not answered yet",
  },
};

export function ClientDecisionBadge({ clientStatus }: { clientStatus: ClientStatus }) {
  const look = STATUS_LOOK[clientStatus];
  return (
    // The hidden prefix tells a screen reader user what the word refers to: in a list row it
    // stands next to the status badge and would otherwise read as "Sent Approved".
    <Badge variant="secondary" className={look.className} data-client-status={clientStatus} title={look.title}>
      <span className="sr-only">Client decision: </span>
      {clientStatus}
    </Badge>
  );
}
