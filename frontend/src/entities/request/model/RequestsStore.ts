import { makeAutoObservable, observableRef, runInAction } from "mobx";
import { ApiError, getErrorMessage } from "@/shared/api";
import type { RequestsApi } from "../api/requestsApi";
import type { NewPartnerRequest, PartnerRequest } from "./types";

export type LoadState = "idle" | "loading" | "ready" | "error";

// State of the "open one request" screen.
export type DetailState =
  | { id: string; status: "loading" | "ready" | "not-found" }
  | { id: string; status: "error"; message: string };

// ULIDs sort by creation time, so comparing the ids gives "newest first" without parsing
// dates. (Plain < and > on purpose: ids are ASCII, no locale rules wanted.)
const newestFirst = (a: PartnerRequest, b: PartnerRequest) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

// Combine what we already have with what the server just sent. Same id: the server's
// copy wins. Reads are eventually consistent, so a list fetched right after a create may
// not contain the new item yet; keeping what we already know stops it from vanishing.
function mergeById(known: PartnerRequest[], incoming: PartnerRequest[]): PartnerRequest[] {
  const byId = new Map(known.map((request) => [request.id, request]));
  for (const request of incoming) byId.set(request.id, request);
  return [...byId.values()].sort(newestFirst);
}

// Why an observable store and not component state: the requests are shared by several
// screens (list, form, details). The form adds an item that the list must show, and the
// details page reuses what the list already loaded. Component state would be lost on
// every navigation and would have to be passed around by hand.
export class RequestsStore {
  items: PartnerRequest[] = [];
  listState: LoadState = "idle";
  listError: string | null = null;
  detail: DetailState | null = null;

  constructor(private readonly api: RequestsApi) {
    makeAutoObservable<RequestsStore, "api">(this, {
      api: false, // a dependency, not state
      // A request is never edited in place: `items` is replaced by a new array. `observableRef` makes
      // MobX watch that assignment only, instead of wrapping every item in a proxy.
      items: observableRef,
    });
  }

  findById(id: string): PartnerRequest | undefined {
    return this.items.find((request) => request.id === id);
  }

  // Every method here is a MobX action. Code after an `await` is no longer inside the
  // action, so those state changes are wrapped in runInAction.
  async loadList(): Promise<void> {
    this.listState = "loading";
    this.listError = null;
    try {
      const incoming = await this.api.list();
      runInAction(() => {
        this.items = mergeById(this.items, incoming);
        this.listState = "ready";
      });
    } catch (error) {
      runInAction(() => {
        this.listState = "error";
        this.listError = getErrorMessage(error);
      });
    }
  }

  async loadDetail(id: string): Promise<void> {
    // Already known (from the list, or just created): show it without a request. Right
    // after a create a fresh GET could even answer 404 because of eventual consistency.
    // Statuses will change in later stages; then this is the place to refresh in the background.
    if (this.findById(id)) {
      this.detail = { id, status: "ready" };
      return;
    }

    this.detail = { id, status: "loading" };
    try {
      const request = await this.api.get(id);
      runInAction(() => {
        this.items = mergeById(this.items, [request]);
        // The user may have moved on to another request while this one was loading.
        if (this.detail?.id === id) this.detail = { id, status: "ready" };
      });
    } catch (error) {
      runInAction(() => {
        if (this.detail?.id !== id) return;
        this.detail =
          error instanceof ApiError && error.status === 404
            ? { id, status: "not-found" }
            : { id, status: "error", message: getErrorMessage(error) };
      });
    }
  }

  // Sends the new request and puts the object the server answered with into `items`, so
  // the list shows it immediately (a re-read could still miss it). Errors are thrown to
  // the caller: the form decides how to show them.
  async create(input: NewPartnerRequest): Promise<PartnerRequest> {
    const created = await this.api.create(input);
    runInAction(() => {
      this.items = mergeById(this.items, [created]);
    });
    return created;
  }
}
