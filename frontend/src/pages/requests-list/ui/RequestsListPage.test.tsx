import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeRequest, makeRequestsApi } from "@test/factories";
import { renderWithProviders } from "@test/render";
import { ApiError } from "@/shared/api";
import { RequestsStore } from "@/entities/request";
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
