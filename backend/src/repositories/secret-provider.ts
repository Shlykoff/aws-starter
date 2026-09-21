// Where a service gets a shared secret from, for example the token that signs the webhook.
// The service asks for it before it needs it and never sees where it is kept.
//
// `ApiKeyProvider` (the worker's port) is the same plus `invalidate`. The webhook has no
// `invalidate` on purpose: a wrong signature would let anybody on the internet force a read
// of SSM (see WebhookService).
export interface SecretProvider {
  /** The current secret. It is never logged. */
  get(): Promise<string>;
}
