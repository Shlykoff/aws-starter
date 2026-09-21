import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeClientDecision, makeRequest, makeRequestsApi } from "@test/factories";
import { renderWithProviders } from "@test/render";
import { ApiError } from "@/shared/api";
import { RequestsStore, STATUS_POLL_INTERVAL_MS } from "@/entities/request";
import { RequestsListPage } from "./RequestsListPage";

function setup() {
  const api = makeRequestsApi();
  const requests = new RequestsStore(api);
  return { api, requests };
}

describe("RequestsListPage", () => {
  it("shows a loading skeleton while the requests load", () => {
    const { api, requests } = setup();
    api.list.mockReturnValue(new Promise(() => undefined));

    renderWithProviders(<RequestsListPage />, { requests });

    expect(screen.getByRole("status", { name: "Loading requests" })).toBeInTheDocument();
  });

  it("shows the empty state when there are no requests", async () => {
    const { requests } = setup();

    renderWithProviders(<RequestsListPage />, { requests });

    expect(await screen.findByText("No requests yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create a request" })).toHaveAttribute("href", "/requests/new");
  });

  it("lists the requests with their status and a link to each one", async () => {
    const { api, requests } = setup();
    const first = makeRequest({ subject: "First subject", status: "created" });
    const second = makeRequest({ subject: "Second subject", status: "sent" });
    api.list.mockResolvedValue([second, first]);

    renderWithProviders(<RequestsListPage />, { requests });

    const link = await screen.findByRole("link", { name: "Second subject" });
    expect(link).toHaveAttribute("href", `/requests/${second.id}`);
    const row = link.closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("Sent")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "First subject" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /New request/ })).toHaveAttribute("href", "/requests/new");
  });

  it("shows what the client decided next to the status, only in the rows that have a decision", async () => {
    const { api, requests } = setup();
    const approved = makeRequest({
      subject: "Approved one",
      status: "sent",
      clientDecision: makeClientDecision({ decision: "Approved" }),
    });
    const declined = makeRequest({
      subject: "Declined one",
      status: "failed",
      clientDecision: makeClientDecision({ decision: "Declined", reason: "Out of stock." }),
    });
    const waiting = makeRequest({ subject: "Waiting one", status: "sent" });
    api.list.mockResolvedValue([waiting, declined, approved]);

    renderWithProviders(<RequestsListPage />, { requests });

    const rowOf = async (subject: string) =>
      within((await screen.findByRole("link", { name: subject })).closest("tr") as HTMLElement);
    const approvedRow = await rowOf("Approved one");
    expect(approvedRow.getByText("Sent")).toBeInTheDocument();
    expect(approvedRow.getByText("Approved")).toHaveAttribute("data-client-status", "Approved");
    // The delivery status stays as it was: the decision is shown in addition, not instead.
    const declinedRow = await rowOf("Declined one");
    expect(declinedRow.getByText("Failed")).toBeInTheDocument();
    expect(declinedRow.getByText("Declined")).toHaveAttribute("data-client-status", "Declined");
    // No decision yet on a delivered request: it says Waiting, and neither Approved nor Declined.
    const waitingRow = await rowOf("Waiting one");
    expect(waitingRow.getByText("Sent")).toBeInTheDocument();
    expect(waitingRow.getByText("Waiting")).toHaveAttribute("data-client-status", "Waiting");
    expect(waitingRow.queryByText(/Approved|Declined/)).not.toBeInTheDocument();
    // The reason is for the details page; the list stays compact.
    expect(screen.queryByText("Out of stock.")).not.toBeInTheDocument();
  });

  it("shows no client status in the rows of requests that were not delivered", async () => {
    const { api, requests } = setup();
    const statuses = ["created", "queued", "failed", "rejected"] as const;
    api.list.mockResolvedValue(statuses.map((status) => makeRequest({ subject: `Row ${status}`, status })));

    renderWithProviders(<RequestsListPage />, { requests });

    for (const status of statuses) {
      const row = within((await screen.findByRole("link", { name: `Row ${status}` })).closest("tr") as HTMLElement);
      expect(row.getByText(new RegExp(`^${status}$`, "i"))).toBeInTheDocument();
      expect(row.queryByText(/Waiting|Approved|Declined/)).not.toBeInTheDocument();
    }
  });

  it("shows an error alert and retries when the button is pressed", async () => {
    const { api, requests } = setup();
    api.list.mockRejectedValueOnce(new ApiError(500, "internal_error", "Internal server error"));

    const { user } = renderWithProviders(<RequestsListPage />, { requests });

    expect(await screen.findByRole("alert")).toHaveTextContent("Internal server error");
    expect(screen.queryByText("No requests yet")).not.toBeInTheDocument();

    api.list.mockResolvedValue([makeRequest({ subject: "Recovered" })]);
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("link", { name: "Recovered" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("RequestsListPage status polling", () => {
  // Fake timers, so five seconds pass instantly and no real time is spent waiting.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Moves the fake clock and lets the promises of the fake API settle; act() makes React
  // apply the resulting re-render before the test looks at the page.
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  const statusOf = (subject: string) =>
    within(screen.getByRole("link", { name: subject }).closest("tr") as HTMLElement).getByText(
      /^(Created|Queued|Sent|Rejected|Failed)$/,
    ).textContent;

  it("follows a request from created to queued to sent, then stops asking", async () => {
    const { api, requests } = setup();
    const created = makeRequest({ subject: "Watched", status: "created" });
    api.list
      .mockResolvedValueOnce([created])
      .mockResolvedValueOnce([{ ...created, status: "queued" }])
      .mockResolvedValue([{ ...created, status: "sent" }]);

    renderWithProviders(<RequestsListPage />, { requests });
    await advance(0);
    expect(statusOf("Watched")).toBe("Created");

    await advance(STATUS_POLL_INTERVAL_MS);
    expect(statusOf("Watched")).toBe("Queued");

    await advance(STATUS_POLL_INTERVAL_MS);
    expect(statusOf("Watched")).toBe("Sent");
    expect(api.list).toHaveBeenCalledTimes(3);

    // Everything is terminal now: a minute later there is still no further request.
    await advance(60_000);
    expect(api.list).toHaveBeenCalledTimes(3);
  });

  it("does not poll at all when every request is already terminal", async () => {
    const { api, requests } = setup();
    api.list.mockResolvedValue([
      makeRequest({ status: "sent" }),
      makeRequest({ status: "rejected" }),
      makeRequest({ status: "failed" }),
    ]);

    renderWithProviders(<RequestsListPage />, { requests });
    await advance(60_000);

    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it("keeps polling while at least one request is still pending", async () => {
    const { api, requests } = setup();
    const done = makeRequest({ subject: "Done", status: "sent" });
    const waiting = makeRequest({ subject: "Waiting", status: "created" });
    api.list
      .mockResolvedValueOnce([waiting, done])
      .mockResolvedValueOnce([{ ...waiting, status: "queued" }, done])
      .mockResolvedValue([{ ...waiting, status: "rejected" }, done]);

    renderWithProviders(<RequestsListPage />, { requests });
    await advance(0);
    await advance(STATUS_POLL_INTERVAL_MS * 2);
    expect(statusOf("Waiting")).toBe("Rejected");
    expect(statusOf("Done")).toBe("Sent");

    await advance(60_000);
    expect(api.list).toHaveBeenCalledTimes(3);
  });

  it("keeps the rows and keeps polling when a refresh fails", async () => {
    const { api, requests } = setup();
    const request = makeRequest({ subject: "Still here", status: "queued" });
    api.list
      .mockResolvedValueOnce([request])
      .mockRejectedValueOnce(new ApiError(500, "internal_error", "Internal server error"))
      .mockResolvedValue([{ ...request, status: "sent" }]);

    renderWithProviders(<RequestsListPage />, { requests });
    await advance(0);
    await advance(STATUS_POLL_INTERVAL_MS);

    // The failed refresh neither removed the row nor showed the error alert.
    expect(statusOf("Still here")).toBe("Queued");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await advance(STATUS_POLL_INTERVAL_MS);
    expect(statusOf("Still here")).toBe("Sent");
  });

  it("stops asking when the page is closed", async () => {
    const { api, requests } = setup();
    api.list.mockResolvedValue([makeRequest({ status: "queued" })]);

    const { unmount } = renderWithProviders(<RequestsListPage />, { requests });
    await advance(0);
    unmount();
    await advance(60_000);

    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it("does not poll while the page's own load is still running", async () => {
    const { api, requests } = setup();
    // A request the store already knows (e.g. just created) is on screen while the list loads.
    api.create.mockResolvedValue(makeRequest({ status: "created" }));
    await requests.create({ partner: "p", subject: "s", body: "b" });
    api.list.mockReturnValue(new Promise(() => undefined));

    renderWithProviders(<RequestsListPage />, { requests });
    await advance(60_000);

    expect(api.list).toHaveBeenCalledTimes(1);
  });
});
