// Where the worker gets the API key of the recipient from. The service asks for it before
// every call and never sees where it is kept.
export interface ApiKeyProvider {
  /** The current key. It is never logged. */
  get(): Promise<string>;

  /**
   * Forget the key that was read earlier, so the next `get()` reads it again. The service
   * calls it when the recipient answers 401 or 403: the key may have been rotated since it
   * was read.
   */
  invalidate(): void;
}
