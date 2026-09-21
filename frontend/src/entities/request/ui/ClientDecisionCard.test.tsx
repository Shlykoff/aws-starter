import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeClientDecision, makeRequest } from "@test/factories";
import { formatDateTime } from "@/shared/lib";
import type { PartnerRequest } from "../model/types";
import { ClientDecisionCard } from "./ClientDecisionCard";

const show = (overrides: Partial<PartnerRequest>) => render(<ClientDecisionCard request={makeRequest(overrides)} />);
const card = () => screen.getByRole("region", { name: "Client decision" });

describe("ClientDecisionCard with a decision", () => {
  it("shows an approval as a word, when the client acted, and the reason", () => {
    const at = "2025-02-03T14:30:00.000Z";
    show({ status: "sent", clientDecision: makeClientDecision({ decision: "Approved", at, reason: "Paid by card." }) });

    expect(screen.getByRole("heading", { name: "Client decision" })).toBeInTheDocument();
    expect(within(card()).getByText("Approved")).toHaveAttribute("data-client-status", "Approved");
    const time = within(card()).getByText(formatDateTime(at));
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("datetime", at);
    expect(within(card()).getByText("Paid by card.")).toBeInTheDocument();
    expect(within(card()).queryByText("Waiting")).not.toBeInTheDocument();
    expect(screen.queryByText(/has not answered yet/)).not.toBeInTheDocument();
  });

  it("shows a decline the same way, in its own words and look", () => {
    show({ status: "sent", clientDecision: makeClientDecision({ decision: "Declined", reason: "Out of stock." }) });

    expect(within(card()).getByText("Declined")).toHaveAttribute("data-client-status", "Declined");
    expect(within(card()).queryByText("Approved")).not.toBeInTheDocument();
    expect(within(card()).getByText("Out of stock.")).toBeInTheDocument();
  });

  it("shows a decision without a reason: the word and the time, and no empty reason block", () => {
    show({ status: "sent", clientDecision: makeClientDecision({ decision: "Declined" }) });

    expect(within(card()).getByText("Declined")).toBeInTheDocument();
    expect(within(card()).getByText(formatDateTime("2025-02-03T14:30:00.000Z"))).toBeInTheDocument();
    expect(screen.queryByText("Reason given by the client")).not.toBeInTheDocument();
  });

  it("shows the time the client acted, not the time we stored it", () => {
    show({
      status: "sent",
      clientDecision: makeClientDecision({ at: "2025-02-03T14:30:00.000Z", receivedAt: "2025-03-09T08:00:00.000Z" }),
    });

    expect(within(card()).getByText(formatDateTime("2025-02-03T14:30:00.000Z"))).toBeInTheDocument();
    expect(screen.queryByText(formatDateTime("2025-03-09T08:00:00.000Z"))).not.toBeInTheDocument();
  });

  // The event is accepted whatever the delivery status is, so a decision is shown for any status.
  it.each(["created", "queued", "sent", "failed", "rejected"] as const)("shows a decision on a %s request", (status) => {
    show({ status, clientDecision: makeClientDecision({ decision: "Approved" }) });

    expect(within(card()).getByText("Approved")).toBeInTheDocument();
  });
});

describe("ClientDecisionCard without a decision", () => {
  it("says Waiting for a delivered request: a word, and a calm sentence with no error, spinner or deadline", () => {
    show({ status: "sent" });

    expect(within(card()).getByText("Waiting")).toHaveAttribute("data-client-status", "Waiting");
    expect(within(card()).getByText("The client has not answered yet. It can arrive at any time.")).toBeInTheDocument();
    expect(within(card()).queryByText(/Approved|Declined/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(card().textContent).not.toMatch(/overdue|late|expired|timeout|deadline/i);
  });

  it("turns Waiting into the decision when the decision arrives, in the same card", () => {
    const request = makeRequest({ status: "sent" });
    const { rerender } = render(<ClientDecisionCard request={request} />);
    expect(within(card()).getByText("Waiting")).toBeInTheDocument();

    rerender(
      <ClientDecisionCard request={{ ...request, clientDecision: makeClientDecision({ decision: "Declined" }) }} />,
    );

    expect(within(card()).getByText("Declined")).toBeInTheDocument();
    expect(within(card()).queryByText("Waiting")).not.toBeInTheDocument();
    expect(screen.queryByText(/has not answered yet/)).not.toBeInTheDocument();
  });

  // Nothing is expected from the client before delivery, or after a delivery that did not happen.
  it.each(["created", "queued", "failed", "rejected"] as const)("shows nothing for a %s request", (status) => {
    const { container } = show({ status });

    expect(container).toBeEmptyDOMElement();
  });
});

describe("ClientDecisionCard with text from a third party", () => {
  const hostile = [
    "<script>alert(1)</script>",
    '<img src="x" onerror="alert(2)">',
    '<a href="javascript:alert(3)">click here</a>',
    "javascript:alert(4)",
    "https://phish.example/login",
  ].join("\n");

  it("shows markup, script and links in the reason as literal text and creates no element from them", () => {
    const { container } = show({ status: "sent", clientDecision: makeClientDecision({ reason: hostile }) });

    // Exactly what was sent, characters and line breaks, in one text node with no children.
    const reason = within(card()).getByText("Reason given by the client").nextElementSibling;
    expect(reason?.textContent).toBe(hostile);
    expect(reason?.children).toHaveLength(0);
    // And the card holds no script, image, link or frame made from it.
    expect(container.querySelector("script, img, a, iframe, [onerror]")).toBeNull();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("keeps a long word with no spaces in one piece of text", () => {
    const token = "A".repeat(500);
    show({ status: "sent", clientDecision: makeClientDecision({ reason: token }) });

    expect(within(card()).getByText(token)).toBeInTheDocument();
  });
});
