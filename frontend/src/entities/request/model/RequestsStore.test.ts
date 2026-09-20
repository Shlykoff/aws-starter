import { describe, expect, it } from "vitest";
import { makeRequest, makeRequestsApi } from "@test/factories";
import { ApiError } from "@/shared/api";
import { RequestsStore } from "./RequestsStore";

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
    await store.create({ partner: created.partner, subject: created.subject, body: created.body });

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

describe("RequestsStore.create", () => {
  it("sends the input and puts the returned request at the top of the list", async () => {
    const { api, store } = setup();
    const created = makeRequest();
    api.create.mockResolvedValue(created);

    const result = await store.create({ partner: "Acme", subject: "Hello", body: "Text" });

    expect(api.create).toHaveBeenCalledWith({ partner: "Acme", subject: "Hello", body: "Text" });
    expect(result).toBe(created);
    expect(store.items).toEqual([created]);
    // The list is not re-read after a create (a re-read could miss the new item).
    expect(api.list).not.toHaveBeenCalled();
  });

  it("throws the error and leaves the list unchanged when the API rejects the request", async () => {
    const { api, store } = setup();
    api.create.mockRejectedValue(new ApiError(400, "validation_error", "partner is required"));

    await expect(store.create({ partner: "", subject: "s", body: "b" })).rejects.toMatchObject({
      code: "validation_error",
    });
    expect(store.items).toEqual([]);
  });
});

describe("RequestsStore.loadDetail", () => {
  it("uses a request that is already known without calling the API", async () => {
    const { api, store } = setup();
    const known = makeRequest();
    api.create.mockResolvedValue(known);
    await store.create({ partner: "p", subject: "s", body: "b" });

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
