// Where the archived log batches are kept: one gzipped object per key.
export interface LogArchiveStore {
  /** Stores the object. Storing the same key again overwrites it, it does not add a second one. */
  put(key: string, body: Uint8Array): Promise<void>;
}
