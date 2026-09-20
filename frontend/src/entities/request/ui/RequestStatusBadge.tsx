import { Badge } from "@/shared/ui/badge";
import type { RequestStatus } from "../model/types";

// One look per status. The label is always visible text, so the meaning never depends on
// colour alone. Typed as Record<RequestStatus, ...>: adding a status to the API makes
// this table fail to compile until it gets a look.
const STATUS_LOOK: Record<RequestStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; className?: string }> = {
  created: { label: "Created", variant: "outline" },
  queued: { label: "Queued", variant: "secondary" },
  sent: {
    label: "Sent",
    variant: "default",
    className: "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950",
  },
  failed: { label: "Failed", variant: "destructive" },
  rejected: {
    label: "Rejected",
    variant: "outline",
    className: "border-amber-500 text-amber-700 dark:text-amber-400",
  },
};

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  const look = STATUS_LOOK[status];
  return (
    <Badge variant={look.variant} className={look.className} data-status={status}>
      {look.label}
    </Badge>
  );
}
