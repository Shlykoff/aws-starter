import { describe, expect, it } from "vitest";
import { makeExchange, makeExchangeApi } from "@test/factories";
import { ApiError } from "@/shared/api";
import { ExchangeStore } from "./ExchangeStore";
import type { Exchange } from "./types";

function setup() {
  const api = makeExchangeApi();
  return { api, store: new ExchangeStore(api) };
}

describe("ExchangeStore.load", () => {
  it("goes through loading to ready with the exchange", async () => {
    const { api, store } = setup();
    const exchange = makeExchange();
    api.get.mockResolvedValue(exchange);

    const loading = store.load("r1");
    expect(store.stateFor("r1")).toEqual({ id: "r1", status: "loading" });
    await loading;

    expect(api.get).toHaveBeenCalledWith("r1");
    expect(store.stateFor("r1")).toEqual({ id: "r1", status: "ready", exchange });
  });

  it("treats a 404 as empty, not as an error: no delivery attempt yet", async () => {
    const { api, store } = setup();
    api.get.mockRejectedValue(new ApiError(404, "not_found", "Request not found"));

    await store.load("r1");

    expect(store.stateFor("r1")).toEqual({ id: "r1", status: "empty" });
  });

  it("keeps the message of any other failure, and can recover on a second load", async () => {
    const { api, store } = setup();
    api.get.mockRejectedValueOnce(new ApiError(500, "internal_error", "Internal server error"));

    await store.load("r1");
    expect(store.stateFor("r1")).toEqual({ id: "r1", status: "error", message: "Internal server error" });

    const exchange = makeExchange();
    api.get.mockResolvedValue(exchange);
    await store.load("r1");
    expect(store.stateFor("r1")).toEqual({ id: "r1", status: "ready", exchange });
  });

  it("uses a generic message for errors that are not ApiErrors (for example an answer that breaks the contract)", async () => {
    const { api, store } = setup();
    api.get.mockRejectedValue(new Error("internal detail"));

    await store.load("r1");

    expect(store.stateFor("r1")).toEqual({
      id: "r1",
      status: "error",
      message: "Something went wrong. Please try again.",
    });
  });

  it("holds nothing for a request it was not asked about", async () => {
    const { api, store } = setup();
    api.get.mockResolvedValue(makeExchange());

    expect(store.stateFor("r1")).toBeNull();
    await store.load("r1");

    expect(store.stateFor("other")).toBeNull();
  });

  it("ignores a slow answer for a request the user has already left", async () => {
    const { api, store } = setup();
    const first = makeExchange({ attempt: 1 });
    const second = makeExchange({ attempt: 2 });
    let answerFirst: (exchange: Exchange) => void = () => undefined;
    api.get.mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)));
    api.get.mockResolvedValueOnce(second);

    const slow = store.load("r1");
    await store.load("r2");
    answerFirst(first);
    await slow;

    expect(store.stateFor("r1")).toBeNull();
    expect(store.stateFor("r2")).toEqual({ id: "r2", status: "ready", exchange: second });
  });
});

describe("ExchangeStore.refresh", () => {
  it("replaces the exchange with the newer attempt without a loading state in between", async () => {
    const { api, store } = setup();
    api.get.mockResolvedValue(makeExchange({ attempt: 1, outcome: "retry", reply: null }));
    await store.load("r1");

    const newer = makeExchange({ attempt: 2 });
    api.get.mockResolvedValue(newer);
    const refreshing = store.refresh("r1");
    expect(store.stateFor("r1")?.status).toBe("ready");
    await refreshing;

    expect(store.stateFor("r1")).toEqual({ id: "r1", status: "ready", exchange: newer });
  });

  it("turns empty into ready once the first attempt has been recorded", async () => {
    const { api, store } = setup();
    api.get.mockRejectedValueOnce(new ApiError(404, "not_found", "Request not found"));
    await store.load("r1");
    expect(store.stateFor("r1")?.status).toBe("empty");

    const exchange = makeExchange();
    api.get.mockResolvedValue(exchange);
    await store.refresh("r1");

    expect(store.stateFor("r1")).toEqual({ id: "r1", status: "ready", exchange });
  });

  it("keeps the exchange on screen when a refresh fails or answers 404", async () => {
    const { api, store } = setup();
    const exchange = makeExchange();
    api.get.mockResolvedValue(exchange);
    await store.load("r1");

    api.get.mockRejectedValueOnce(new ApiError(0, "network_error", "Cannot reach the server."));
    await store.refresh("r1");
    api.get.mockRejectedValueOnce(new ApiError(404, "not_found", "Request not found"));
    await store.refresh("r1");

    expect(store.stateFor("r1")).toEqual({ id: "r1", status: "ready", exchange });
  });

  it("shows the failure when there is nothing better on screen", async () => {
    const { api, store } = setup();
    api.get.mockRejectedValueOnce(new ApiError(404, "not_found", "Request not found"));
    await store.load("r1");

    api.get.mockRejectedValue(new ApiError(500, "internal_error", "Internal server error"));
    await store.refresh("r1");

    expect(store.stateFor("r1")).toEqual({ id: "r1", status: "error", message: "Internal server error" });
  });

  it("does nothing to the state of another request when the answer is for one the user has left", async () => {
    // A polling tick that started on request 1 may finish after the page moved to request 2.
    const { api, store } = setup();
    const second = makeExchange({ attempt: 2 });
    api.get.mockResolvedValueOnce(makeExchange({ attempt: 1 }));
    await store.load("r1");
    let answer: (exchange: Exchange) => void = () => undefined;
    api.get.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));

    const refreshing = store.refresh("r1");
    api.get.mockResolvedValueOnce(second);
    await store.load("r2");
    answer(makeExchange({ attempt: 3 }));
    await refreshing;

    expect(store.stateFor("r2")).toEqual({ id: "r2", status: "ready", exchange: second });
  });
});
