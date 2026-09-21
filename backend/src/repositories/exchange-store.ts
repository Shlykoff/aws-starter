import type { Exchange } from "../domain/exchange";

// Where the record of the latest delivery attempt of a request is kept (docs/api.md,
// "The exchange record"): one object per request. It holds the text of the request, so it is
// only ever read after the caller has proved that the request is theirs.
export interface ExchangeStore {
  /** Stores the record. Storing it again overwrites: it always describes the latest attempt. */
  save(requestId: string, exchange: Exchange): Promise<void>;

  /**
   * The record, or `undefined` when there is none yet. ONLY "there is none" gives
   * `undefined`: every other failure (no permission, a broken object) is thrown, so that
   * a problem of ours never looks like "no delivery attempt yet".
   */
  find(requestId: string): Promise<Exchange | undefined>;
}
