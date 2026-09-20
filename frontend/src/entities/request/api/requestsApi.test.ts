import { describe, expect, it, vi } from "vitest";
import { makeRequest } from "@test/factories";
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
    const input = { partner: "Acme", subject: "Hello", body: "Text" };

    await expect(api.create(input)).resolves.toEqual(request);
    expect(client.post).toHaveBeenCalledWith("/requests", input);
  });

  it("rejects a response that does not match the documented shape", async () => {
    const { client, api } = setup();
    client.get.mockResolvedValue({ items: [{ id: "1", status: "teleported" }] });

    await expect(api.list()).rejects.toThrow();
  });
});
