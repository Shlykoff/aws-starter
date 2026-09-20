import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { REQUEST_STATUSES } from "../model/types";
import { RequestStatusBadge } from "./RequestStatusBadge";

describe("RequestStatusBadge", () => {
  const labels = { created: "Created", queued: "Queued", sent: "Sent", failed: "Failed", rejected: "Rejected" };

  it.each(REQUEST_STATUSES)("renders the %s status with its own label", (status) => {
    render(<RequestStatusBadge status={status} />);

    expect(screen.getByText(labels[status])).toHaveAttribute("data-status", status);
  });

  it("gives every status a different look", () => {
    const classes = REQUEST_STATUSES.map((status) => {
      const { container, unmount } = render(<RequestStatusBadge status={status} />);
      const className = container.firstElementChild?.getAttribute("class");
      unmount();
      return className;
    });

    expect(new Set(classes).size).toBe(REQUEST_STATUSES.length);
  });
});
