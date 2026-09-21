import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ClientStatus } from "../model/types";
import { ClientDecisionBadge } from "./ClientDecisionBadge";

// Every value the badge can show: the API's two decisions and the derived "Waiting".
const CLIENT_STATUSES: readonly ClientStatus[] = ["Approved", "Declined", "Waiting"];

describe("ClientDecisionBadge", () => {
  it.each(CLIENT_STATUSES)("says %s in words", (clientStatus) => {
    render(<ClientDecisionBadge clientStatus={clientStatus} />);

    expect(screen.getByText(clientStatus)).toHaveAttribute("data-client-status", clientStatus);
  });

  it("names what the word refers to for a screen reader, so a list row does not read 'Sent Approved'", () => {
    render(<ClientDecisionBadge clientStatus="Approved" />);

    expect(screen.getByText("Approved")).toHaveTextContent("Client decision: Approved");
  });

  it("keeps the screen reader prefix on Waiting too", () => {
    render(<ClientDecisionBadge clientStatus="Waiting" />);

    expect(screen.getByText("Waiting")).toHaveTextContent("Client decision: Waiting");
  });

  it("explains on hover that a Waiting request was delivered and the client has not answered", () => {
    render(<ClientDecisionBadge clientStatus="Waiting" />);

    expect(screen.getByText("Waiting")).toHaveAttribute(
      "title",
      "The message was delivered; the client has not answered yet",
    );
  });

  it("gives every client status a different look", () => {
    const classes = CLIENT_STATUSES.map((clientStatus) => {
      const { container, unmount } = render(<ClientDecisionBadge clientStatus={clientStatus} />);
      const className = container.firstElementChild?.getAttribute("class");
      unmount();
      return className;
    });

    expect(new Set(classes).size).toBe(CLIENT_STATUSES.length);
  });
});
