import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client";
import { ApiError, getErrorMessage } from "./errors";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function setup(options: { token?: string | null; response?: Response | Error } = {}) {
  const { token = "access-token-123", response = json({ ok: true }) } = options;
  const fetchImpl = vi.fn<typeof fetch>(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  const onUnauthorized = vi.fn();
  const client = createApiClient({
    baseUrl: "https://api.example.com",
    getAccessToken: () => Promise.resolve(token),
    onUnauthorized,
    fetchImpl,
  });
  return { client, fetchImpl, onUnauthorized };
}

// The (url, init) pair of the first fetch call.
const firstCall = (fetchImpl: ReturnType<typeof setup>["fetchImpl"]) => {
  const [url, init] = fetchImpl.mock.calls[0] ?? [];
  return { url, init };
};

describe("createApiClient", () => {
  it("sends the access token as a Bearer header and returns the parsed body", async () => {
    const { client, fetchImpl } = setup({ response: json({ items: [] }) });

    const data = await client.get("/requests");

    const { url, init } = firstCall(fetchImpl);
    expect(url).toBe("https://api.example.com/requests");
    expect(init?.method).toBe("GET");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer access-token-123" });
    expect(data).toEqual({ items: [] });
  });

  it("sends a JSON body with a content type on POST", async () => {
    const { client, fetchImpl } = setup();

    await client.post("/requests", { partner: "Acme" });

    const { init } = firstCall(fetchImpl);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ partner: "Acme" }));
    expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("sends a POST without a body and without a content type when there is nothing to send", async () => {
    const { client, fetchImpl } = setup();

    await client.post("/requests/1/retry");

    const { init } = firstCall(fetchImpl);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    expect(init?.headers).not.toHaveProperty("Content-Type");
  });

  it("maps the API error shape to an ApiError", async () => {
    const { client } = setup({
      response: json({ error: { code: "validation_error", message: "partner is required", details: [1] } }, 400),
    });

    const error = await client.post("/requests", {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: "validation_error",
      message: "partner is required",
      details: [1],
    });
  });

  it("falls back to a generic error when the failure body is not our error shape", async () => {
    const { client } = setup({ response: json({ message: "Internal Server Error" }, 500) });

    const error = await client.get("/requests").catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 500, code: "http_error", message: "The request failed (HTTP 500)." });
  });

  it("treats 401 specially: notifies the app and does not use the error body", async () => {
    const { client, onUnauthorized } = setup({ response: json({ message: "Unauthorized" }, 401) });

    const error = await client.get("/requests").catch((e: unknown) => e);

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("does not call the API at all when there is no access token", async () => {
    const { client, fetchImpl, onUnauthorized } = setup({ token: null });

    const error = await client.get("/requests").catch((e: unknown) => e);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("reports a network failure as an ApiError with status 0", async () => {
    const { client } = setup({ response: new TypeError("Failed to fetch") });

    const error = await client.get("/requests").catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 0, code: "network_error" });
  });
});

describe("getErrorMessage", () => {
  it("shows the message of an ApiError and a generic one for anything else", () => {
    expect(getErrorMessage(new ApiError(404, "not_found", "Request not found"))).toBe("Request not found");
    expect(getErrorMessage(new Error("boom: internal detail"))).toBe("Something went wrong. Please try again.");
  });
});
