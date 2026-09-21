import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeExchange, makeExchangeApi, makeRequest, makeRequestsApi } from "@test/factories";
import { renderWithProviders } from "@test/render";
import { ApiError } from "@/shared/api";
import { ExchangeStore } from "@/entities/exchange";
import { RequestsStore, STATUS_POLL_INTERVAL_MS } from "@/entities/request";
import { RequestDetailsPage } from "./RequestDetailsPage";

function setup() {
  const api = makeRequestsApi();
  const requests = new RequestsStore(api);
  // Unless a test sets it, the exchange API answers 404: no delivery attempt yet.
  const exchangeApi = makeExchangeApi();
  const exchange = new ExchangeStore(exchangeApi);
  const open = (id: string) =>
    renderWithProviders(<RequestDetailsPage />, {
      requests,
      exchange,
      route: `/requests/${id}`,
      path: "/requests/:id",
    });
  return { api, requests, exchangeApi, open };
}

describe("RequestDetailsPage", () => {
  it("loads and shows the request", async () => {
    const { api, open } = setup();
    const request = makeRequest({ subject: "Big order", partner: "Acme", body: "Line one", status: "queued" });
    api.get.mockResolvedValue(request);

    open(request.id);

    expect(screen.getByRole("status", { name: "Loading request" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Big order" })).toBeInTheDocument();
    expect(screen.getByText(/Acme/)).toBeInTheDocument();
    expect(screen.getByText("Line one")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(request.id);
  });

  it("shows a not found state when the API answers 404", async () => {
    const { api, open } = setup();
    api.get.mockRejectedValue(new ApiError(404, "not_found", "Request not found"));

    open("nope");

    expect(await screen.findByText("Request not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /All requests/ })).toHaveAttribute("href", "/");
  });

  it("shows an error with a retry button for other failures", async () => {
    const { api, open } = setup();
    const request = makeRequest({ subject: "Second try" });
    api.get.mockRejectedValueOnce(new ApiError(0, "network_error", "Cannot reach the server."));

    const { user } = open(request.id);

    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot reach the server.");

    api.get.mockResolvedValue(request);
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Second try" })).toBeInTheDocument();
  });
});

describe("RequestDetailsPage status explanation", () => {
  it("explains a rejected request", async () => {
    const { api, open } = setup();
    const request = makeRequest({ status: "rejected" });
    api.get.mockResolvedValue(request);

    open(request.id);

    expect(
      await screen.findByText("The request was refused, by the partner or by our own check of the message. It was not retried."),
    ).toBeInTheDocument();
  });

  it("explains a failed request", async () => {
    const { api, open } = setup();
    const request = makeRequest({ status: "failed" });
    api.get.mockResolvedValue(request);

    open(request.id);

    expect(
      await screen.findByText("Delivery was attempted several times and did not succeed. The request needs attention."),
    ).toBeInTheDocument();
  });

  it.each(["created", "queued", "sent"] as const)("shows no explanation for a %s request", async (status) => {
    const { api, open } = setup();
    const request = makeRequest({ status, subject: "Plain one" });
    api.get.mockResolvedValue(request);

    open(request.id);

    await screen.findByRole("heading", { name: "Plain one" });
    expect(screen.queryByText(/The request was refused/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Delivery was attempted/)).not.toBeInTheDocument();
  });
});

describe("RequestDetailsPage status polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it("follows the status until it is terminal, shows the explanation, then stops asking", async () => {
    const { api, open } = setup();
    const request = makeRequest({ subject: "Watched", status: "created" });
    api.get
      .mockResolvedValueOnce(request)
      .mockResolvedValueOnce({ ...request, status: "queued" })
      .mockResolvedValue({ ...request, status: "failed" });

    open(request.id);
    await advance(0);
    expect(screen.getByText("Created")).toBeInTheDocument();

    await advance(STATUS_POLL_INTERVAL_MS);
    expect(screen.getByText("Queued")).toBeInTheDocument();

    await advance(STATUS_POLL_INTERVAL_MS);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText(/The request needs attention/)).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(3);

    await advance(60_000);
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  it("does not poll a request that is already terminal", async () => {
    const { api, open } = setup();
    const request = makeRequest({ status: "sent" });
    api.get.mockResolvedValue(request);

    open(request.id);
    await advance(60_000);

    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("keeps showing the request when a refresh answers 404 or fails", async () => {
    const { api, open } = setup();
    const request = makeRequest({ subject: "Just created", status: "created" });
    api.get
      .mockResolvedValueOnce(request)
      .mockRejectedValueOnce(new ApiError(404, "not_found", "Request not found"))
      .mockRejectedValueOnce(new ApiError(500, "internal_error", "Internal server error"))
      .mockResolvedValue({ ...request, status: "sent" });

    open(request.id);
    await advance(0);

    await advance(STATUS_POLL_INTERVAL_MS);
    expect(screen.getByRole("heading", { name: "Just created" })).toBeInTheDocument();
    expect(screen.queryByText("Request not found")).not.toBeInTheDocument();

    await advance(STATUS_POLL_INTERVAL_MS);
    expect(screen.getByRole("heading", { name: "Just created" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await advance(STATUS_POLL_INTERVAL_MS);
    expect(screen.getByText("Sent")).toBeInTheDocument();
  });

  it("asks the API again for a request that is already in the store (opened from the list)", async () => {
    const { api, requests, open } = setup();
    const request = makeRequest({ status: "queued" });
    api.create.mockResolvedValue(request);
    await requests.create({ partner: "p", subject: "s", body: "b" });
    api.get.mockResolvedValue({ ...request, status: "sent" });

    open(request.id);
    await advance(0);
    // Opening a known request needs no call; the first refresh comes with the first tick.
    expect(api.get).not.toHaveBeenCalled();

    await advance(STATUS_POLL_INTERVAL_MS);
    expect(api.get).toHaveBeenCalledWith(request.id);
    expect(screen.getByText("Sent")).toBeInTheDocument();
  });

  it("stops asking when the page is closed", async () => {
    const { api, open } = setup();
    const request = makeRequest({ status: "queued" });
    api.get.mockResolvedValue(request);

    const { unmount } = open(request.id);
    await advance(0);
    unmount();
    await advance(60_000);

    expect(api.get).toHaveBeenCalledTimes(1);
  });
});

describe("RequestDetailsPage exchange panel", () => {
  it("shows a calm empty state while nothing has been sent yet", async () => {
    const { api, exchangeApi, open } = setup();
    const request = makeRequest({ status: "queued" });
    api.get.mockResolvedValue(request);

    open(request.id);

    expect(await screen.findByText("No delivery attempt to show")).toBeInTheDocument();
    expect(exchangeApi.get).toHaveBeenCalledWith(request.id);
    // A 404 is not an error, so nothing on the page is announced as one.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows what was sent and what came back", async () => {
    const { api, exchangeApi, open } = setup();
    const request = makeRequest({ status: "sent" });
    api.get.mockResolvedValue(request);
    exchangeApi.get.mockResolvedValue(makeExchange({ attempt: 3 }));

    open(request.id);

    expect(await screen.findByText("Attempt 3")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Request XML" })).toHaveTextContent("<Submission");
    expect(screen.getByRole("region", { name: "Reply XML" })).toHaveTextContent("<Reply");
  });

  it("asks for the exchange of a request that is already known without waiting for the request", async () => {
    const { api, requests, exchangeApi, open } = setup();
    const request = makeRequest({ status: "sent" });
    api.create.mockResolvedValue(request);
    await requests.create({ partner: "p", subject: "s", body: "b" });
    exchangeApi.get.mockResolvedValue(makeExchange());

    open(request.id);

    expect(await screen.findByText("Attempt 1")).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it("shows an error with a retry button when the exchange cannot be loaded, and keeps the request", async () => {
    const { api, exchangeApi, open } = setup();
    const request = makeRequest({ status: "sent", subject: "Still here" });
    api.get.mockResolvedValue(request);
    exchangeApi.get.mockRejectedValueOnce(new ApiError(500, "internal_error", "Internal server error"));

    const { user } = open(request.id);

    expect(await screen.findByRole("alert")).toHaveTextContent("Internal server error");
    expect(screen.getByRole("heading", { name: "Still here" })).toBeInTheDocument();

    exchangeApi.get.mockResolvedValue(makeExchange());
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Attempt 1")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows no exchange for a request that was not found", async () => {
    const { api, open } = setup();
    api.get.mockRejectedValue(new ApiError(404, "not_found", "Request not found"));

    open("nope");

    expect(await screen.findByText("Request not found")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Exchange" })).not.toBeInTheDocument();
  });

  it("shows the XML of the exchange as text on the page", async () => {
    const { api, exchangeApi, open } = setup();
    const request = makeRequest({ status: "rejected" });
    api.get.mockResolvedValue(request);
    const hostile = '<script>alert(1)</script><img src="x" onerror="alert(2)">';
    exchangeApi.get.mockResolvedValue(
      makeExchange({
        outcome: "refused",
        reply: { httpStatus: 422, xml: hostile, valid: false, status: "Rejected", code: "X", description: hostile },
      }),
    );

    const { container } = open(request.id);

    expect(await screen.findByRole("region", { name: "Reply XML" })).toHaveTextContent(hostile);
    expect(container.querySelector("script, img")).toBeNull();
  });
});

describe("RequestDetailsPage exchange polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it("follows every attempt while the request stays queued, then shows the final one and stops asking", async () => {
    const { api, exchangeApi, open } = setup();
    const request = makeRequest({ status: "queued" });
    // The status stays `queued` through the first two ticks; only the third sees `sent`.
    api.get
      .mockResolvedValueOnce(request)
      .mockResolvedValueOnce(request)
      .mockResolvedValueOnce(request)
      .mockResolvedValue({ ...request, status: "sent" });
    exchangeApi.get
      .mockRejectedValueOnce(new ApiError(404, "not_found", "Request not found"))
      .mockResolvedValueOnce(makeExchange({ attempt: 1, outcome: "retry", reply: null }))
      .mockResolvedValueOnce(makeExchange({ attempt: 2, outcome: "retry", reply: null }))
      .mockResolvedValue(makeExchange({ attempt: 3, outcome: "delivered" }));

    open(request.id);
    await advance(0);
    expect(screen.getByText("No delivery attempt to show")).toBeInTheDocument();

    await advance(STATUS_POLL_INTERVAL_MS);
    expect(screen.getByText("Attempt 1")).toBeInTheDocument();
    expect(screen.getByText("Temporary failure")).toBeInTheDocument();

    await advance(STATUS_POLL_INTERVAL_MS);
    expect(screen.getByText("Attempt 2")).toBeInTheDocument();

    await advance(STATUS_POLL_INTERVAL_MS);
    expect(screen.getByText("Attempt 3")).toBeInTheDocument();
    expect(screen.getByText("Delivered")).toBeInTheDocument();
    expect(exchangeApi.get).toHaveBeenCalledTimes(4);

    // The request is terminal now: no more asking, for the request or for the exchange.
    await advance(60_000);
    expect(exchangeApi.get).toHaveBeenCalledTimes(4);
  });

  it("asks for the exchange once when the request is already terminal", async () => {
    const { api, exchangeApi, open } = setup();
    const request = makeRequest({ status: "failed" });
    api.get.mockResolvedValue(request);
    exchangeApi.get.mockResolvedValue(makeExchange({ outcome: "retry", reply: null }));

    open(request.id);
    await advance(60_000);

    expect(exchangeApi.get).toHaveBeenCalledTimes(1);
  });

  it("keeps the last exchange on screen when a refresh fails", async () => {
    const { api, exchangeApi, open } = setup();
    const request = makeRequest({ status: "queued" });
    api.get.mockResolvedValue(request);
    exchangeApi.get
      .mockResolvedValueOnce(makeExchange({ attempt: 1, outcome: "retry", reply: null }))
      .mockRejectedValueOnce(new ApiError(500, "internal_error", "Internal server error"))
      .mockResolvedValue(makeExchange({ attempt: 2, outcome: "retry", reply: null }));

    open(request.id);
    await advance(0);
    expect(screen.getByText("Attempt 1")).toBeInTheDocument();

    await advance(STATUS_POLL_INTERVAL_MS);
    expect(screen.getByText("Attempt 1")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await advance(STATUS_POLL_INTERVAL_MS);
    expect(screen.getByText("Attempt 2")).toBeInTheDocument();
  });
});
