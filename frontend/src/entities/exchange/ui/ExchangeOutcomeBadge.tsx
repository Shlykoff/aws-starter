import { Badge } from "@/shared/ui/badge";
import type { ExchangeOutcome } from "../model/types";

// One look and one plain sentence per outcome. The label is always visible text, so the
// meaning never depends on colour alone. Typed as Record<ExchangeOutcome, ...>: adding an
// outcome to the API makes this table fail to compile until it gets a look.
//
// `retry` is worded as a fact ("Temporary failure"), not as a promise ("Will retry"): the
// record of the LAST attempt also says `retry` when the attempts have run out, and then the
// request is `failed` and nothing is retried any more.
const OUTCOME_LOOK: Record<
  ExchangeOutcome,
  {
    label: string;
    explanation: string;
    variant: "default" | "secondary" | "destructive" | "outline";
    className?: string;
  }
> = {
  delivered: {
    label: "Delivered",
    explanation: "The partner accepted the message.",
    variant: "default",
    className: "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950",
  },
  refused: {
    label: "Refused",
    explanation: "The partner refused the message. It was not retried.",
    variant: "outline",
    className: "border-amber-500 text-amber-700 dark:text-amber-400",
  },
  retry: {
    label: "Temporary failure",
    explanation:
      "The partner gave no usable answer (an error, a timeout or no connection). Delivery is retried automatically until the attempts run out.",
    variant: "secondary",
    className: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-300",
  },
  invalid_request: {
    label: "Invalid request",
    explanation: "Our message did not pass the schema check, so it was not sent. Retrying cannot change that.",
    variant: "destructive",
  },
  unrepresentable: {
    label: "Cannot be sent as XML",
    explanation:
      "The text contains characters that XML cannot carry, so no message could be built and nothing was sent.",
    variant: "destructive",
  },
};

export function getOutcomeExplanation(outcome: ExchangeOutcome): string {
  return OUTCOME_LOOK[outcome].explanation;
}

export function ExchangeOutcomeBadge({ outcome }: { outcome: ExchangeOutcome }) {
  const look = OUTCOME_LOOK[outcome];
  return (
    <Badge variant={look.variant} className={look.className} data-outcome={outcome}>
      {look.label}
    </Badge>
  );
}
