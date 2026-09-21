import type { RequestStatus } from "../model/types";

// A sentence for the two bad outcomes, where the label alone does not say what happened or
// what to do. The other statuses speak for themselves, so they have none.
const EXPLANATIONS: Partial<Record<RequestStatus, string>> = {
  // "Rejected" also covers a message that failed our own schema check: it was then never sent.
  rejected: "The request was refused, by the partner or by our own check of the message. It was not retried.",
  failed: "Delivery was attempted several times and did not succeed. The request needs attention.",
};

export function getStatusExplanation(status: RequestStatus): string | undefined {
  return EXPLANATIONS[status];
}
