// One error type for every failed API call, so callers only have to know about this one.
export class ApiError extends Error {
  // HTTP status, or 0 when no response arrived at all (network down, timeout, CORS).
  readonly status: number;
  // The `error.code` from our API ("validation_error", "not_found", ...) or one we
  // invent for cases the API did not answer: "unauthorized", "network_error", "http_error".
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// The text shown to the user. Only ApiError messages are written for people; anything
// else (a bug, an unexpected response shape) gets a generic sentence instead of a stack
// trace or a technical message.
export function getErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Something went wrong. Please try again.";
}
