import { makeAutoObservable, observableRef, runInAction } from "mobx";
import { ApiError, getErrorMessage } from "@/shared/api";
import type { ExchangeApi } from "../api/exchangeApi";
import type { Exchange } from "./types";

// What the exchange panel shows for one request.
//   loading: asked, no answer yet.
//   empty:   the API answered 404: there is no delivery attempt to show (yet). A normal
//            situation while the request is created or queued, not an error.
//   ready:   the record of the latest attempt.
//   error:   anything else (network, 500, an answer that does not match the contract).
export type ExchangeState =
  | { id: string; status: "loading" }
  | { id: string; status: "empty" }
  | { id: string; status: "ready"; exchange: Exchange }
  | { id: string; status: "error"; message: string };

// Why an observable store and not component state: the same reason as RequestsStore, in
// small. The rules below (what a 404 means, a failed refresh must not take the shown
// exchange away, a slow answer for a request the user has left is dropped) are plain
// logic that can be tested without React, and the page and the panel share the state
// through MobX instead of passing it around. Only one screen uses it, so there is no
// cache: the store remembers the request it was last asked about, nothing more.
export class ExchangeStore {
  // Replaced as a whole, never edited in place, so MobX only watches the assignment.
  state: ExchangeState | null = null;

  constructor(private readonly api: ExchangeApi) {
    makeAutoObservable<ExchangeStore, "api">(this, {
      api: false, // a dependency, not state
      state: observableRef,
    });
  }

  // The state if it belongs to this request, otherwise null (nothing asked yet, or the
  // store still holds the previous request's exchange during a navigation).
  stateFor(id: string): ExchangeState | null {
    return this.state?.id === id ? this.state : null;
  }

  // The page opened (or "Try again"): show the loading state and ask.
  async load(id: string): Promise<void> {
    this.state = { id, status: "loading" };
    await this.fetch(id);
  }

  // The background refresh behind the polling: it asks again without going through the
  // loading state, so what is on screen does not flicker. Call it after `load`.
  async refresh(id: string): Promise<void> {
    await this.fetch(id);
  }

  private async fetch(id: string): Promise<void> {
    try {
      const exchange = await this.api.get(id);
      runInAction(() => {
        // The user may have moved on to another request while this one was loading.
        if (this.state?.id === id) this.state = { id, status: "ready", exchange };
      });
    } catch (error) {
      runInAction(() => {
        const current = this.state;
        if (current?.id !== id) return;
        // A refresh that fails must not take a good record off the screen; the next poll
        // tries again. Everything else has nothing better to show than the failure.
        if (current.status === "ready") return;
        this.state =
          error instanceof ApiError && error.status === 404
            ? { id, status: "empty" }
            : { id, status: "error", message: getErrorMessage(error) };
      });
    }
  }
}
