import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeRequest, makeRequestsApi } from "@test/factories";
import { renderWithProviders } from "@test/render";
import { ApiError } from "@/shared/api";
import { RequestsStore } from "@/entities/request";
import { CreateRequestForm } from "./CreateRequestForm";

function setup() {
  const api = makeRequestsApi();
  const requests = new RequestsStore(api);
  const onCreated = vi.fn();
  const view = renderWithProviders(<CreateRequestForm onCreated={onCreated} />, { requests });
  return { api, onCreated, ...view };
}

async function fillIn(
  user: ReturnType<typeof setup>["user"],
  values: { partner?: string; subject?: string; body?: string },
) {
  if (values.partner !== undefined) await user.type(screen.getByLabelText("Partner"), values.partner);
  if (values.subject !== undefined) await user.type(screen.getByLabelText("Subject"), values.subject);
  if (values.body !== undefined) await user.type(screen.getByLabelText("Message"), values.body);
}

describe("CreateRequestForm", () => {
  it("shows a message per empty field, does not call the API and focuses the first problem", async () => {
    const { api, onCreated, user } = setup();

    await user.click(screen.getByRole("button", { name: "Send request" }));

    expect(screen.getByText("Enter the partner name.")).toBeInTheDocument();
    expect(screen.getByText("Enter the subject.")).toBeInTheDocument();
    expect(screen.getByText("Enter the message.")).toBeInTheDocument();
    expect(screen.getByLabelText("Partner")).toHaveFocus();
    expect(screen.getByLabelText("Partner")).toHaveAttribute("aria-invalid", "true");
    expect(api.create).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("treats a value made only of spaces as empty", async () => {
    const { api, user } = setup();

    await fillIn(user, { partner: "   ", subject: "Hello", body: "Text" });
    await user.click(screen.getByRole("button", { name: "Send request" }));

    expect(screen.getByText("Enter the partner name.")).toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
  });

  it("rejects a value that is longer than the server allows", async () => {
    const { api, user } = setup();

    await fillIn(user, { partner: "p".repeat(101), subject: "Hello", body: "Text" });
    await user.click(screen.getByRole("button", { name: "Send request" }));

    expect(screen.getByText("The partner name can have at most 100 characters.")).toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
  });

  it("sends the trimmed input through the store and reports the created request", async () => {
    const { api, onCreated, requests, user } = setup();
    const created = makeRequest({ partner: "Acme", subject: "Hello", body: "Text" });
    api.create.mockResolvedValue(created);

    await fillIn(user, { partner: "  Acme ", subject: "Hello", body: "Text" });
    await user.click(screen.getByRole("button", { name: "Send request" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(api.create).toHaveBeenCalledWith({ partner: "Acme", subject: "Hello", body: "Text" });
    expect(requests.items).toEqual([created]);
  });

  it("disables the submit button while the request is being sent", async () => {
    const { api, user } = setup();
    let finish: (request: ReturnType<typeof makeRequest>) => void = () => undefined;
    api.create.mockImplementation(() => new Promise((resolve) => (finish = resolve)));

    await fillIn(user, { partner: "Acme", subject: "Hello", body: "Text" });
    await user.click(screen.getByRole("button", { name: "Send request" }));

    const sending = await screen.findByRole("button", { name: "Sending…" });
    expect(sending).toBeDisabled();

    finish(makeRequest());
    await waitFor(() => expect(api.create).toHaveBeenCalledOnce());
  });

  it("shows the API error, keeps the input and moves focus to the error", async () => {
    const { api, onCreated, user } = setup();
    api.create.mockRejectedValue(new ApiError(500, "internal_error", "Internal server error"));

    await fillIn(user, { partner: "Acme", subject: "Hello", body: "Text" });
    await user.click(screen.getByRole("button", { name: "Send request" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The request was not sent");
    expect(alert).toHaveTextContent("Internal server error");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByLabelText("Partner")).toHaveValue("Acme");
    expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
