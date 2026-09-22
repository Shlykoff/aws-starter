import { describe, expect, it } from "vitest";
import { makeDeferred, makeRequest, makeRequestsApi } from "@test/factories";
import { ApiError } from "@/shared/api";
import { RequestsStore } from "./RequestsStore";
import type { PartnerRequest } from "./types";

function setup() {
  const api = makeRequestsApi();
  return { api, store: new RequestsStore(api) };
}

describe("RequestsStore.loadList", () => {
  it("loads the requests, newest first", async () => {
    const { api, store } = setup();
    const older = makeRequest();
    const newer = makeRequest();
    api.list.mockResolvedValue([older, newer]);

    const loading = store.loadList();
    expect(store.listState).toBe("loading");
    await loading;

    expect(store.listState).toBe("ready");
    expect(store.items).toEqual([newer, older]);
  });

  it("keeps the message of a failed load and can recover on retry", async () => {
    const { api, store } = setup();
    api.list.mockRejectedValueOnce(new ApiError(500, "internal_error", "Internal server error"));

    await store.loadList();

    expect(store.listState).toBe("error");
    expect(store.listError).toBe("Internal server error");

    const request = makeRequest();
    api.list.mockResolvedValue([request]);
    await store.loadList();

    expect(store.listState).toBe("ready");
    expect(store.listError).toBeNull();
    expect(store.items).toEqual([request]);
  });

  it("uses a generic message for errors that are not ApiErrors", async () => {
    const { api, store } = setup();
    api.list.mockRejectedValue(new Error("internal detail"));

    await store.loadList();

    expect(store.listError).toBe("Something went wrong. Please try again.");
  });

  it("keeps a request that was just created when the list does not contain it yet", async () => {
    // Reads are eventually consistent: the server list may miss the item we just created.
    const { api, store } = setup();
    const existing = makeRequest();
    const created = makeRequest();
    api.create.mockResolvedValue(created);
    await store.create({ subject: created.subject, body: created.body });

    api.list.mockResolvedValue([existing]);
    await store.loadList();

    expect(store.items).toEqual([created, existing]);
  });

  it("replaces a known request with the server's copy", async () => {
    const { api, store } = setup();
    const before = makeRequest({ status: "created" });
    api.list.mockResolvedValue([before]);
    await store.loadList();

    api.list.mockResolvedValue([{ ...before, status: "sent" }]);
    await store.loadList();

    expect(store.items).toEqual([{ ...before, status: "sent" }]);
  });
});

describe("RequestsStore.hasPendingItems", () => {
  it("is false when there are no requests", () => {
    expect(setup().store.hasPendingItems).toBe(false);
  });

  it.each([
    ["created", true],
    ["queued", true],
    ["sent", false],
    ["rejected", false],
    ["failed", false],
  ] as const)("for a request that is %s it is %s", async (status, expected) => {
    const { api, store } = setup();
    api.list.mockResolvedValue([makeRequest({ status })]);

    await store.loadList();

    expect(store.hasPendingItems).toBe(expected);
  });

  it("stays true while one request is pending among terminal ones", async () => {
    const { api, store } = setup();
    api.list.mockResolvedValue([makeRequest({ status: "sent" }), makeRequest({ status: "queued" })]);

    await store.loadList();

    expect(store.hasPendingItems).toBe(true);
  });
});

describe("RequestsStore.refreshList", () => {
  it("merges by id: the server's copy wins and no known request is dropped", async () => {
    const { api, store } = setup();
    const changing = makeRequest({ status: "created" });
    const missedByServer = makeRequest({ status: "created" });
    api.list.mockResolvedValue([changing]);
    await store.loadList();
    // A just-created request that an eventually consistent read does not return yet.
    api.create.mockResolvedValue(missedByServer);
    await store.create({ subject: "s", body: "b" });

    api.list.mockResolvedValue([{ ...changing, status: "queued" }]);
    await store.refreshList();

    expect(store.items).toEqual([missedByServer, { ...changing, status: "queued" }]);
  });

  it("does not show a loading state while refreshing", async () => {
    const { api, store } = setup();
    api.list.mockResolvedValue([makeRequest()]);
    await store.loadList();

    api.list.mockResolvedValue([makeRequest()]);
    const refreshing = store.refreshList();
    expect(store.listState).toBe("ready");
    await refreshing;

    expect(store.listState).toBe("ready");
  });

  it("keeps the requests on screen and the state unchanged when a refresh fails", async () => {
    const { api, store } = setup();
    const request = makeRequest({ status: "queued" });
    api.list.mockResolvedValue([request]);
    await store.loadList();

    api.list.mockRejectedValue(new ApiError(500, "internal_error", "Internal server error"));
    await store.refreshList();

    expect(store.items).toEqual([request]);
    expect(store.listState).toBe("ready");
    expect(store.listError).toBeNull();
  });

  it("uses the error state when it fails and there is nothing to show", async () => {
    const { api, store } = setup();
    api.list.mockRejectedValue(new ApiError(0, "network_error", "Cannot reach the server."));

    await store.refreshList();

    expect(store.listState).toBe("error");
    expect(store.listError).toBe("Cannot reach the server.");
  });

  it("clears an earlier error once a refresh succeeds", async () => {
    const { api, store } = setup();
    const request = makeRequest({ status: "created" });
    api.list.mockResolvedValueOnce([request]).mockRejectedValueOnce(new ApiError(500, "internal_error", "Boom"));
    await store.loadList();
    await store.loadList();
    expect(store.listState).toBe("error");

    api.list.mockResolvedValue([{ ...request, status: "sent" }]);
    await store.refreshList();

    expect(store.listState).toBe("ready");
    expect(store.listError).toBeNull();
    expect(store.items).toEqual([{ ...request, status: "sent" }]);
  });
});

describe("RequestsStore.create", () => {
  it("sends the input and puts the returned request at the top of the list", async () => {
    const { api, store } = setup();
    const created = makeRequest();
    api.create.mockResolvedValue(created);

    const result = await store.create({ subject: "Hello", body: "Text" });

    expect(api.create).toHaveBeenCalledWith({ subject: "Hello", body: "Text" });
    expect(result).toBe(created);
    expect(store.items).toEqual([created]);
    // The list is not re-read after a create (a re-read could miss the new item).
    expect(api.list).not.toHaveBeenCalled();
  });

  it("throws the error and leaves the list unchanged when the API rejects the request", async () => {
    const { api, store } = setup();
    api.create.mockRejectedValue(new ApiError(400, "validation_error", "subject is required"));

    await expect(store.create({ subject: "", body: "b" })).rejects.toMatchObject({
      code: "validation_error",
    });
    expect(store.items).toEqual([]);
  });
});

describe("RequestsStore.retry", () => {
  // A failed request that the store already knows, as after opening the list.
  async function setupFailed() {
    const { api, store } = setup();
    const failed = makeRequest({ status: "failed" });
    api.list.mockResolvedValue([failed]);
    await store.loadList();
    return { api, store, failed };
  }

  it("puts the returned request (status created) into the store and raises the flag only while it runs", async () => {
    const { api, store, failed } = await setupFailed();
    const answer = makeDeferred<PartnerRequest>();
    api.retry.mockReturnValue(answer.promise);

    const running = store.retry(failed.id);
    expect(store.isRetrying(failed.id)).toBe(true);
    // Only this request is busy; the others keep their button.
    expect(store.isRetrying("another-id")).toBe(false);

    answer.resolve({ ...failed, status: "created" });

    await expect(running).resolves.toBe("retried");
    expect(api.retry).toHaveBeenCalledWith(failed.id);
    expect(store.isRetrying(failed.id)).toBe(false);
    expect(store.findById(failed.id)?.status).toBe("created");
    // A created request is not final, so the list page polls again.
    expect(store.hasPendingItems).toBe(true);
  });

  it("on 409 not_retryable does not throw: it reads the request again and reports it", async () => {
    const { api, store, failed } = await setupFailed();
    api.retry.mockRejectedValue(new ApiError(409, "not_retryable", "The request cannot be sent again"));
    api.get.mockResolvedValue({ ...failed, status: "queued" });

    await expect(store.retry(failed.id)).resolves.toBe("not-retryable");

    expect(api.get).toHaveBeenCalledWith(failed.id);
    expect(store.findById(failed.id)?.status).toBe("queued");
    expect(store.isRetrying(failed.id)).toBe(false);
  });

  it("throws any other error, changes nothing and lets the button be used again", async () => {
    const { api, store, failed } = await setupFailed();
    api.retry.mockRejectedValue(new ApiError(500, "internal_error", "Internal server error"));

    await expect(store.retry(failed.id)).rejects.toMatchObject({ code: "internal_error" });

    expect(store.findById(failed.id)?.status).toBe("failed");
    expect(store.isRetrying(failed.id)).toBe(false);
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe("RequestsStore.loadDetail", () => {
  it("uses a request that is already known without calling the API", async () => {
    const { api, store } = setup();
    const known = makeRequest();
    api.create.mockResolvedValue(known);
    await store.create({ subject: "s", body: "b" });

    await store.loadDetail(known.id);

    expect(api.get).not.toHaveBeenCalled();
    expect(store.detail).toEqual({ id: known.id, status: "ready" });
    expect(store.findById(known.id)).toEqual(known);
  });

  it("fetches an unknown request and remembers it", async () => {
    const { api, store } = setup();
    const fetched = makeRequest();
    api.get.mockResolvedValue(fetched);

    const loading = store.loadDetail(fetched.id);
    expect(store.detail).toEqual({ id: fetched.id, status: "loading" });
    await loading;

    expect(api.get).toHaveBeenCalledWith(fetched.id);
    expect(store.detail).toEqual({ id: fetched.id, status: "ready" });
    expect(store.findById(fetched.id)).toEqual(fetched);
  });

  it("marks the request as not found on a 404", async () => {
    const { api, store } = setup();
    api.get.mockRejectedValue(new ApiError(404, "not_found", "Request not found"));

    await store.loadDetail("missing-id");

    expect(store.detail).toEqual({ id: "missing-id", status: "not-found" });
  });

  it("stores the message for any other failure", async () => {
    const { api, store } = setup();
    api.get.mockRejectedValue(new ApiError(0, "network_error", "Cannot reach the server."));

    await store.loadDetail("some-id");

    expect(store.detail).toEqual({ id: "some-id", status: "error", message: "Cannot reach the server." });
  });

  it("ignores a slow answer for a request the user has already left", async () => {
    const { api, store } = setup();
    const first = makeRequest();
    const second = makeRequest();
    let answerFirst: (request: typeof first) => void = () => undefined;
    api.get.mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)));
    api.get.mockResolvedValueOnce(second);

    const slow = store.loadDetail(first.id);
    await store.loadDetail(second.id);
    answerFirst(first);
    await slow;

    expect(store.detail).toEqual({ id: second.id, status: "ready" });
  });
});

describe("RequestsStore.refreshDetail", () => {
  async function openKnown(status: PartnerRequest["status"] = "queued") {
    const ctx = setup();
    const known = makeRequest({ status });
    ctx.api.create.mockResolvedValue(known);
    await ctx.store.create({ subject: "s", body: "b" });
    await ctx.store.loadDetail(known.id);
    return { ...ctx, known };
  }

  it("really asks the API, even for a request the store already knows, and takes the new status", async () => {
    const { api, store, known } = await openKnown("queued");
    expect(api.get).not.toHaveBeenCalled();
    api.get.mockResolvedValue({ ...known, status: "sent" });

    await store.refreshDetail(known.id);

    expect(api.get).toHaveBeenCalledWith(known.id);
    expect(store.findById(known.id)?.status).toBe("sent");
    expect(store.detail).toEqual({ id: known.id, status: "ready" });
  });

  it("keeps the cached request when the API answers 404 for an id it already knows", async () => {
    // Right after a create the read may not see the new item yet (eventual consistency).
    const { api, store, known } = await openKnown("created");
    api.get.mockRejectedValue(new ApiError(404, "not_found", "Request not found"));

    await store.refreshDetail(known.id);

    expect(store.findById(known.id)).toEqual(known);
    expect(store.detail).toEqual({ id: known.id, status: "ready" });
  });

  it("keeps the cached request when a refresh fails for any other reason", async () => {
    const { api, store, known } = await openKnown("queued");
    api.get.mockRejectedValue(new ApiError(0, "network_error", "Cannot reach the server."));

    await store.refreshDetail(known.id);

    expect(store.findById(known.id)).toEqual(known);
    expect(store.detail).toEqual({ id: known.id, status: "ready" });
  });

  it("ignores an answer for a request the user has already left", async () => {
    const { api, store, known } = await openKnown("queued");
    const other = makeRequest();
    let answer: (request: PartnerRequest) => void = () => undefined;
    api.get.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));

    const refreshing = store.refreshDetail(known.id);
    api.get.mockResolvedValueOnce(other);
    await store.loadDetail(other.id);
    answer({ ...known, status: "sent" });
    await refreshing;

    expect(store.detail).toEqual({ id: other.id, status: "ready" });
    // The fresh status is still remembered, so the list and a later visit see it.
    expect(store.findById(known.id)?.status).toBe("sent");
  });
});

describe("RequestsStore.loadDetail after a 404", () => {
  it("still says not found for an id the store has never seen", async () => {
    const { api, store } = setup();
    api.get.mockRejectedValue(new ApiError(404, "not_found", "Request not found"));

    await store.loadDetail("never-seen");
    // A refresh of the same unknown id does not change that.
    await store.refreshDetail("never-seen");

    expect(store.detail).toEqual({ id: "never-seen", status: "not-found" });
  });

  it("keeps a request that showed up in the list while the first load was failing", async () => {
    const { api, store } = setup();
    const request = makeRequest();
    let fail: (error: Error) => void = () => undefined;
    api.get.mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)));

    const loading = store.loadDetail(request.id);
    api.list.mockResolvedValue([request]);
    await store.loadList();
    fail(new ApiError(404, "not_found", "Request not found"));
    await loading;

    expect(store.findById(request.id)).toEqual(request);
    expect(store.detail).toEqual({ id: request.id, status: "ready" });
  });
});
