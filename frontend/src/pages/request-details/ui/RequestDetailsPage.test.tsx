import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeClientDecision,
  makeDeferred,
  makeExchange,
  makeExchangeApi,
  makeRequest,
  makeRequestsApi,
} from "@test/factories";
import { renderWithProviders } from "@test/render";
import { ApiError } from "@/shared/api";
import { ExchangeStore } from "@/entities/exchange";
import { DECISION_POLL_INTERVAL_MS, RequestsStore, STATUS_POLL_INTERVAL_MS, type PartnerRequest } from "@/entities/request";
import { RequestDetailsPage } from "./RequestDetailsPage";

function setup() {
  const api = makeRequestsApi();
  const requests = new RequestsStore(api);
  // Unless a test sets it, the exchange API answers null (a 204): no delivery attempt yet.
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
    const request = makeRequest({ subject: "Big order", body: "Line one", status: "queued" });
    api.get.mockResolvedValue(request);

    open(request.id);

    expect(screen.getByRole("status", { name: "Loading request" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Big order" })).toBeInTheDocument();
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
      await screen.findByText("Delivery was attempted several times and did not succeed. You can send it again."),
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
    expect(screen.getByText(/You can send it again/)).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(3);

    await advance(60_000);
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  it("does not poll a request that is already terminal and needs nothing more", async () => {
    const { api, open } = setup();
    // `failed`: nothing was delivered, so no decision is awaited either (`sent` without a
    // decision is asked for slowly, see "decision polling" below).
    const request = makeRequest({ status: "failed" });
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
    await requests.create({ subject: "s", body: "b" });
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
    // No attempt yet is not an error, so nothing on the page is announced as one.
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
    await requests.create({ subject: "s", body: "b" });
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
      .mockResolvedValueOnce(null)
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

    // The request is `sent` now: the exchange is final and is never asked for again (the
    // request itself is, slowly, for a decision).
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

describe("RequestDetailsPage client decision", () => {
  const cardOf = () => screen.queryByRole("region", { name: "Client decision" });

  it("shows the decision between the request and the exchange", async () => {
    const { api, open } = setup();
    const request = makeRequest({
      status: "sent",
      clientDecision: makeClientDecision({ decision: "Declined", reason: "Out of stock." }),
    });
    api.get.mockResolvedValue(request);

    open(request.id);

    const heading = await screen.findByRole("heading", { level: 1 });
    const card = await screen.findByRole("region", { name: "Client decision" });
    const exchange = screen.getByRole("region", { name: "Exchange" });
    expect(within(card).getByText("Declined")).toBeInTheDocument();
    expect(within(card).getByText("Out of stock.")).toBeInTheDocument();
    expect(heading.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(exchange) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says Waiting for a delivered request without a decision", async () => {
    const { api, open } = setup();
    const request = makeRequest({ status: "sent" });
    api.get.mockResolvedValue(request);

    open(request.id);

    const card = await screen.findByRole("region", { name: "Client decision" });
    expect(within(card).getByText("Waiting")).toHaveAttribute("data-client-status", "Waiting");
    expect(within(card).getByText("The client has not answered yet. It can arrive at any time.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["created", "queued", "failed", "rejected"] as const)(
    "shows no decision card for a %s request without a decision",
    async (status) => {
      const { api, open } = setup();
      const request = makeRequest({ status, subject: "No card here" });
      api.get.mockResolvedValue(request);

      open(request.id);

      await screen.findByRole("heading", { name: "No card here" });
      expect(cardOf()).not.toBeInTheDocument();
    },
  );

  it("still shows a decision on a failed request", async () => {
    const { api, open } = setup();
    const request = makeRequest({ status: "failed", clientDecision: makeClientDecision({ decision: "Approved" }) });
    api.get.mockResolvedValue(request);

    open(request.id);

    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(within(await screen.findByRole("region", { name: "Client decision" })).getByText("Approved")).toBeInTheDocument();
  });

  it("shows no decision card when the request was not found", async () => {
    const { api, open } = setup();
    api.get.mockRejectedValue(new ApiError(404, "not_found", "Request not found"));

    open("nope");

    expect(await screen.findByText("Request not found")).toBeInTheDocument();
    expect(cardOf()).not.toBeInTheDocument();
  });
});

describe("RequestDetailsPage decision polling", () => {
  // jsdom has no real tab: the tests decide what the page visibility is and announce a change
  // the way a browser does (set the value, then fire `visibilitychange`).
  let visibility: DocumentVisibilityState;
  beforeEach(() => {
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const changeVisibility = (state: DocumentVisibilityState) =>
    act(async () => {
      visibility = state;
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });

  const WAITING = "The client has not answered yet. It can arrive at any time.";
  const decided = (request: ReturnType<typeof makeRequest>) => ({
    ...request,
    clientDecision: makeClientDecision({ decision: "Approved", reason: "Paid by card." }),
  });

  it("asks every 30 seconds while a delivered request has no decision, then shows it and stops", async () => {
    const { api, exchangeApi, open } = setup();
    const request = makeRequest({ status: "sent" });
    api.get.mockResolvedValueOnce(request).mockResolvedValueOnce(request).mockResolvedValue(decided(request));

    open(request.id);
    await advance(0);
    expect(screen.getByText(WAITING)).toBeInTheDocument();
    expect(screen.getByText("Waiting")).toHaveAttribute("data-client-status", "Waiting");
    expect(api.get).toHaveBeenCalledTimes(1);

    // Slow, not the 5 seconds of the status poll.
    await advance(DECISION_POLL_INTERVAL_MS - 1);
    expect(api.get).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(screen.getByText(WAITING)).toBeInTheDocument();

    await advance(DECISION_POLL_INTERVAL_MS);
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(WAITING)).not.toBeInTheDocument();
    // The same card: Waiting has turned into the decision, without a reload.
    expect(screen.queryByText("Waiting")).not.toBeInTheDocument();
    expect(screen.getByText("Approved")).toHaveAttribute("data-client-status", "Approved");
    expect(screen.getByText("Paid by card.")).toBeInTheDocument();

    // The decision is here: no more asking, however long the page stays open.
    await advance(20 * DECISION_POLL_INTERVAL_MS);
    expect(api.get).toHaveBeenCalledTimes(3);
    // Only the request is asked for: the exchange was final when the request became `sent`.
    expect(exchangeApi.get).toHaveBeenCalledTimes(1);
  });

  it("switches from the status pace to the slow pace when the request becomes sent", async () => {
    const { api, open } = setup();
    const request = makeRequest({ status: "queued" });
    api.get.mockResolvedValueOnce(request).mockResolvedValue({ ...request, status: "sent" });

    open(request.id);
    await advance(0);
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);

    await advance(DECISION_POLL_INTERVAL_MS - 1);
    expect(api.get).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  it("does not ask while the tab is hidden, and asks once at once when it is visible again", async () => {
    const { api, open } = setup();
    const request = makeRequest({ status: "sent" });
    api.get.mockResolvedValueOnce(request).mockResolvedValueOnce(request).mockResolvedValue(decided(request));

    open(request.id);
    await advance(0);
    expect(api.get).toHaveBeenCalledTimes(1);

    await changeVisibility("hidden");
    await advance(10 * DECISION_POLL_INTERVAL_MS);
    expect(api.get).toHaveBeenCalledTimes(1);

    await changeVisibility("visible");
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(screen.getByText(WAITING)).toBeInTheDocument();

    // The slow rhythm goes on from the moment the tab came back.
    await advance(DECISION_POLL_INTERVAL_MS);
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Approved")).toBeInTheDocument();
  });

  it.each(["failed", "rejected"] as const)("never asks for a decision of a %s request", async (status) => {
    const { api, open } = setup();
    const request = makeRequest({ status });
    api.get.mockResolvedValue(request);

    open(request.id);
    await advance(10 * 60_000);

    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("does not ask when the decision is already known", async () => {
    const { api, open } = setup();
    const request = makeRequest({ status: "sent" });
    api.get.mockResolvedValue(decided(request));

    open(request.id);
    await advance(10 * 60_000);

    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting, and keeps asking, when a refresh fails", async () => {
    const { api, open } = setup();
    const request = makeRequest({ status: "sent" });
    api.get
      .mockResolvedValueOnce(request)
      .mockRejectedValueOnce(new ApiError(500, "internal_error", "Internal server error"))
      .mockResolvedValue(decided(request));

    open(request.id);
    await advance(0);
    await advance(DECISION_POLL_INTERVAL_MS);

    expect(screen.getByText(WAITING)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await advance(DECISION_POLL_INTERVAL_MS);
    expect(screen.getByText("Approved")).toBeInTheDocument();
  });

  it("stops asking when the page is left", async () => {
    const { api, open } = setup();
    api.get.mockResolvedValue(makeRequest({ status: "sent" }));

    const { unmount } = open("any");
    await advance(0);
    unmount();
    await advance(10 * DECISION_POLL_INTERVAL_MS);

    expect(api.get).toHaveBeenCalledTimes(1);
  });
});

describe("RequestDetailsPage send again", () => {
  const sendAgain = () => screen.getByRole("button", { name: "Send again" });
  // Lets the promises settle after a call answered by hand (real timers: nothing to advance).
  const settle = () => act(() => Promise.resolve());

  it("offers the button, with a sentence, only for a failed request", async () => {
    const { api, open } = setup();
    const request = makeRequest({ status: "failed" });
    api.get.mockResolvedValue(request);

    open(request.id);

    expect(await screen.findByRole("button", { name: "Send again" })).toBeEnabled();
    expect(screen.getByText("It goes through delivery again, with up to five attempts.")).toBeInTheDocument();
  });

  it.each(["created", "queued", "sent", "rejected"] as const)("offers no button for a %s request", async (status) => {
    const { api, open } = setup();
    const request = makeRequest({ status, subject: "Not failed" });
    api.get.mockResolvedValue(request);

    open(request.id);

    await screen.findByRole("heading", { name: "Not failed" });
    expect(screen.queryByRole("button", { name: /Send again|Sending/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/up to five attempts/)).not.toBeInTheDocument();
  });

  it("calls the API once, then shows the request as created and takes the button away", async () => {
    const { api, open } = setup();
    const request = makeRequest({ status: "failed" });
    api.get.mockResolvedValue(request);
    api.retry.mockResolvedValue({ ...request, status: "created" });

    const { user } = open(request.id);
    await user.click(await screen.findByRole("button", { name: "Send again" }));

    expect(await screen.findByText("Created")).toBeInTheDocument();
    expect(api.retry).toHaveBeenCalledTimes(1);
    expect(api.retry).toHaveBeenCalledWith(request.id);
    expect(screen.queryByRole("button", { name: /Send again|Sending/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/You can send it again/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables the button while the call runs, so a double click sends once", async () => {
    const { api, open } = setup();
    const request = makeRequest({ status: "failed" });
    api.get.mockResolvedValue(request);
    const answer = makeDeferred<PartnerRequest>();
    api.retry.mockReturnValue(answer.promise);

    const { user } = open(request.id);
    await user.dblClick(await screen.findByRole("button", { name: "Send again" }));

    expect(screen.getByRole("button", { name: "Sending..." })).toBeDisabled();
    expect(api.retry).toHaveBeenCalledTimes(1);

    answer.resolve({ ...request, status: "created" });
    await settle();
    expect(screen.getByText("Created")).toBeInTheDocument();
    expect(api.retry).toHaveBeenCalledTimes(1);
  });

  it("answers a 409 with a calm note, no alert, and shows what the request is now", async () => {
    const { api, open } = setup();
    const request = makeRequest({ status: "failed" });
    api.get.mockResolvedValueOnce(request).mockResolvedValue({ ...request, status: "queued" });
    api.retry.mockRejectedValue(new ApiError(409, "not_retryable", "The request cannot be sent again"));

    const { user } = open(request.id);
    await user.click(await screen.findByRole("button", { name: "Send again" }));

    expect(await screen.findByText("This request was already sent again")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send again|Sending/ })).not.toBeInTheDocument();
  });

  it("shows the error and lets the user press the button again", async () => {
    const { api, open } = setup();
    const request = makeRequest({ status: "failed" });
    api.get.mockResolvedValue(request);
    api.retry.mockRejectedValueOnce(new ApiError(500, "internal_error", "Internal server error"));

    const { user } = open(request.id);
    await user.click(await screen.findByRole("button", { name: "Send again" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Internal server error");
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(sendAgain()).toBeEnabled();

    api.retry.mockResolvedValue({ ...request, status: "created" });
    await user.click(sendAgain());

    expect(await screen.findByText("Created")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("RequestDetailsPage send again, polling", () => {
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

  it("follows the status again after sending, until it is sent", async () => {
    const { api, open } = setup();
    const request = makeRequest({ status: "failed" });
    api.get.mockResolvedValueOnce(request);
    api.retry.mockResolvedValue({ ...request, status: "created" });

    open(request.id);
    await advance(0);
    // A failed request is not polled.
    await advance(60_000);
    expect(api.get).toHaveBeenCalledTimes(1);

    api.get.mockResolvedValueOnce({ ...request, status: "queued" }).mockResolvedValue({ ...request, status: "sent" });
    fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    await advance(0);
    expect(screen.getByText("Created")).toBeInTheDocument();

    await advance(STATUS_POLL_INTERVAL_MS);
    expect(screen.getByText("Queued")).toBeInTheDocument();
    await advance(STATUS_POLL_INTERVAL_MS);
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(3);
  });
});

describe("RequestDetailsPage earlier attempt", () => {
  const note = "This is the earlier attempt; the new one replaces it when it has run.";

  it.each(["created", "queued"] as const)("says the exchange is an earlier attempt for a %s request", async (status) => {
    const { api, exchangeApi, open } = setup();
    const request = makeRequest({ status });
    api.get.mockResolvedValue(request);
    exchangeApi.get.mockResolvedValue(makeExchange({ attempt: 5, outcome: "retry", reply: null }));

    open(request.id);

    expect(await screen.findByText("Attempt 5")).toBeInTheDocument();
    expect(screen.getByText(note)).toBeInTheDocument();
  });

  it.each(["failed", "sent", "rejected"] as const)("does not say it for a %s request", async (status) => {
    const { api, exchangeApi, open } = setup();
    const request = makeRequest({ status });
    api.get.mockResolvedValue(request);
    exchangeApi.get.mockResolvedValue(makeExchange());

    open(request.id);

    expect(await screen.findByText("Attempt 1")).toBeInTheDocument();
    expect(screen.queryByText(note)).not.toBeInTheDocument();
  });

  it("does not say it when there is no exchange yet", async () => {
    const { api, open } = setup();
    const request = makeRequest({ status: "created" });
    api.get.mockResolvedValue(request);

    open(request.id);

    expect(await screen.findByText("No delivery attempt to show")).toBeInTheDocument();
    expect(screen.queryByText(note)).not.toBeInTheDocument();
  });

  it("keeps the last attempt on screen, with the note, right after the request is sent again", async () => {
    const { api, exchangeApi, open } = setup();
    const request = makeRequest({ status: "failed" });
    api.get.mockResolvedValue(request);
    exchangeApi.get.mockResolvedValue(makeExchange({ attempt: 5, outcome: "retry", reply: null }));
    api.retry.mockResolvedValue({ ...request, status: "created" });

    const { user } = open(request.id);
    expect(await screen.findByText("Attempt 5")).toBeInTheDocument();
    expect(screen.queryByText(note)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send again" }));

    expect(await screen.findByText(note)).toBeInTheDocument();
    expect(screen.getByText("Attempt 5")).toBeInTheDocument();
  });
});
