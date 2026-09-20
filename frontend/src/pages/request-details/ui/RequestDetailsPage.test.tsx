import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeRequest, makeRequestsApi } from "@test/factories";
import { renderWithProviders } from "@test/render";
import { ApiError } from "@/shared/api";
import { RequestsStore } from "@/entities/request";
import { RequestDetailsPage } from "./RequestDetailsPage";

function setup() {
  const api = makeRequestsApi();
  const requests = new RequestsStore(api);
  const open = (id: string) =>
    renderWithProviders(<RequestDetailsPage />, { requests, route: `/requests/${id}`, path: "/requests/:id" });
  return { api, open };
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
