import { Badge } from "@/shared/ui/badge";
import type { ClientDecisionValue } from "../model/types";

// One look per decision. The word is always visible, so the meaning never depends on colour
// alone. Typed as Record<ClientDecisionValue, ...>: a new decision in the API makes this
// table fail to compile until it gets a look. The tinted look (not the solid one of the
// `Sent` status badge) keeps the two apart when they stand side by side in a list row.
// `Declined` is amber, not red: it is a business answer, not an error of ours.
const DECISION_LOOK: Record<ClientDecisionValue, string> = {
  Approved: "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-300",
  Declined: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-300",
};

export function ClientDecisionBadge({ decision }: { decision: ClientDecisionValue }) {
  return (
    // The hidden prefix tells a screen reader user what the word refers to: in a list row it
    // stands next to the status badge and would otherwise read as "Sent Approved".
    <Badge
      variant="secondary"
      className={DECISION_LOOK[decision]}
      data-decision={decision}
      title="What the client did with the delivered message"
    >
      <span className="sr-only">Client decision: </span>
      {decision}
    </Badge>
  );
}
