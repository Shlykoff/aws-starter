import { describe, expect, it, vi } from "vitest";
import { makeExchange } from "@test/factories";
import type { ApiClient } from "@/shared/api";
import { createExchangeApi } from "./exchangeApi";

function setup() {
  const client = { get: vi.fn<ApiClient["get"]>(), post: vi.fn<ApiClient["post"]>() };
  return { client, api: createExchangeApi(client) };
}

describe("createExchangeApi", () => {
  it("gets the exchange from GET /requests/{id}/exchange and escapes the id in the path", async () => {
    const { client, api } = setup();
    const exchange = makeExchange();
    client.get.mockResolvedValue(exchange);

    await expect(api.get("a/b")).resolves.toEqual(exchange);

    expect(client.get).toHaveBeenCalledWith("/requests/a%2Fb/exchange");
  });

  it("accepts a refusal with problems and a reply that has no body", async () => {
    const { client, api } = setup();
    const exchange = makeExchange({
      outcome: "refused",
      request: { xml: "<a/>", valid: false, problems: [{ element: "Recipient/Name", rule: "pattern" }] },
      reply: { httpStatus: 503, xml: null, valid: false },
    });
    client.get.mockResolvedValue(exchange);

    await expect(api.get("id")).resolves.toEqual(exchange);
  });

  it("accepts an exchange without any reply", async () => {
    const { client, api } = setup();
    const exchange = makeExchange({ outcome: "retry", reply: null });
    client.get.mockResolvedValue(exchange);

    await expect(api.get("id")).resolves.toEqual(exchange);
  });

  it("rejects a response that does not match the documented shape", async () => {
    const { client, api } = setup();
    client.get.mockResolvedValue({ ...makeExchange(), outcome: "teleported" });

    await expect(api.get("id")).rejects.toThrow();
  });
});
