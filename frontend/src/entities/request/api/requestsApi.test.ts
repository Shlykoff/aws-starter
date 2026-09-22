import { describe, expect, it, vi } from "vitest";
import { makeClientDecision, makeRequest } from "@test/factories";
import type { ApiClient } from "@/shared/api";
import { createRequestsApi } from "./requestsApi";

function setup() {
  const client = { get: vi.fn<ApiClient["get"]>(), post: vi.fn<ApiClient["post"]>() };
  return { client, api: createRequestsApi(client) };
}

describe("createRequestsApi", () => {
  it("lists requests from GET /requests", async () => {
    const { client, api } = setup();
    const request = makeRequest();
    client.get.mockResolvedValue({ items: [request] });

    await expect(api.list()).resolves.toEqual([request]);
    expect(client.get).toHaveBeenCalledWith("/requests");
  });

  it("gets one request and escapes the id in the path", async () => {
    const { client, api } = setup();
    const request = makeRequest();
    client.get.mockResolvedValue(request);

    await api.get("a/b");

    expect(client.get).toHaveBeenCalledWith("/requests/a%2Fb");
  });

  it("posts the input to /requests", async () => {
    const { client, api } = setup();
    const request = makeRequest();
    client.post.mockResolvedValue(request);
    const input = { subject: "Hello", body: "Text" };

    await expect(api.create(input)).resolves.toEqual(request);
    expect(client.post).toHaveBeenCalledWith("/requests", input);
  });

  it("sends a failed request again with POST /requests/{id}/retry, without a body", async () => {
    const { client, api } = setup();
    const request = makeRequest({ status: "created" });
    client.post.mockResolvedValue(request);

    await expect(api.retry(request.id)).resolves.toEqual(request);
    expect(client.post).toHaveBeenCalledWith(`/requests/${request.id}/retry`);
  });

  it("escapes the id in the retry path and rejects an answer that does not match the shape", async () => {
    const { client, api } = setup();
    client.post.mockResolvedValue({ id: "1", status: "teleported" });

    await expect(api.retry("a/b")).rejects.toThrow();
    expect(client.post).toHaveBeenCalledWith("/requests/a%2Fb/retry");
  });

  it("rejects a response that does not match the documented shape", async () => {
    const { client, api } = setup();
    client.get.mockResolvedValue({ items: [{ id: "1", status: "teleported" }] });

    await expect(api.list()).rejects.toThrow();
  });

  it("keeps the client decision of a request from GET /requests/{id} and from the list", async () => {
    const { client, api } = setup();
    const decided = makeRequest({
      status: "sent",
      clientDecision: makeClientDecision({ decision: "Declined", reason: "Out of stock." }),
    });
    client.get.mockResolvedValue(decided);
    await expect(api.get(decided.id)).resolves.toEqual(decided);

    client.get.mockResolvedValue({ items: [decided, makeRequest()] });
    const items = await api.list();
    expect(items[0]?.clientDecision).toEqual(decided.clientDecision);
    expect(items[1]).not.toHaveProperty("clientDecision");
  });

  it("rejects a response with an unknown decision or a null clientDecision", async () => {
    const { client, api } = setup();
    const request = makeRequest({ status: "sent" });

    client.get.mockResolvedValue({ ...request, clientDecision: { ...makeClientDecision(), decision: "Maybe" } });
    await expect(api.get(request.id)).rejects.toThrow();

    client.get.mockResolvedValue({ items: [{ ...request, clientDecision: null }] });
    await expect(api.list()).rejects.toThrow();
  });
});
