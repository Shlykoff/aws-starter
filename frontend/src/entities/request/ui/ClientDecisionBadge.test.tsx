import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CLIENT_DECISIONS } from "../model/types";
import { ClientDecisionBadge } from "./ClientDecisionBadge";

describe("ClientDecisionBadge", () => {
  it.each(CLIENT_DECISIONS)("says %s in words", (decision) => {
    render(<ClientDecisionBadge decision={decision} />);

    expect(screen.getByText(decision)).toHaveAttribute("data-decision", decision);
  });

  it("names what the word refers to for a screen reader, so a list row does not read 'Sent Approved'", () => {
    render(<ClientDecisionBadge decision="Approved" />);

    expect(screen.getByText("Approved")).toHaveTextContent("Client decision: Approved");
  });

  it("gives every decision a different look", () => {
    const classes = CLIENT_DECISIONS.map((decision) => {
      const { container, unmount } = render(<ClientDecisionBadge decision={decision} />);
      const className = container.firstElementChild?.getAttribute("class");
      unmount();
      return className;
    });

    expect(new Set(classes).size).toBe(CLIENT_DECISIONS.length);
  });
});
