import type { TerminalStatus } from "../domain/request-status";

// One event per terminal status (docs/api.md, "SNS"). No request text: ids and the status.
export interface StatusEvent {
  requestId: string;
  status: TerminalStatus;
  /** ISO 8601, UTC. */
  at: string;
}

export interface StatusNotifier {
  publish(event: StatusEvent): Promise<void>;
}
