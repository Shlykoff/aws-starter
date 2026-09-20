import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRequest, makeRequestsApi } from "@test/factories";
import { renderWithProviders } from "@test/render";
import { ApiError } from "@/shared/api";
import { RequestsStore, STATUS_POLL_INTERVAL_MS } from "@/entities/request";
import { RequestDetailsPage } from "./RequestDetailsPage";

function setup() {
  const api = makeRequestsApi();
  const requests = new RequestsStore(api);
  const open = (id: string) =>
    renderWithProviders(<RequestDetailsPage />, { requests, route: `/requests/${id}`, path: "/requests/:id" });
  return { api, requests, open };
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

    expect(await screen.findByText("The partner refused this request. It was not retried.")).toBeInTheDocument();
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
    expect(screen.queryByText(/The partner refused/)).not.toBeInTheDocument();
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
