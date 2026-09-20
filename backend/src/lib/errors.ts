// Typed errors. Code below the handler layer throws these and knows nothing about HTTP;
// src/lib/http.ts is the one place that turns them into status codes.

// The `code` values are the ones docs/api.md promises to clients.
export type ErrorCode = "validation_error" | "not_found" | "internal_error";

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The client sent something invalid (400). `details` says what, for example per field. */
export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("validation_error", message, details);
  }
}

/** The thing does not exist, or belongs to someone else (404). Both look the same. */
export class NotFoundError extends AppError {
  constructor(message = "Request not found") {
    super("not_found", message);
  }
}

/**
 * Our own setup is wrong, not the client's input (500). The message is for the logs only:
 * clients always get a generic text (see src/lib/http.ts).
 */
export class MisconfigurationError extends AppError {
  constructor(message: string) {
    super("internal_error", message);
  }
}
