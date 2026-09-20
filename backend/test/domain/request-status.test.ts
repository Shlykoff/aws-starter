import { describe, expect, it } from "vitest";
import { REQUEST_STATUSES } from "../../src/domain/request";
import {
  DELIVERABLE_STATUSES,
  TERMINAL_STATUSES,
  allowedPreviousStatuses,
  isTerminal,
} from "../../src/domain/request-status";

// The rules of docs/api.md, "Statuses". The expectations are written out by hand here, so
// changing a rule in src/ means changing it here too, on purpose.

describe("terminal and deliverable statuses", () => {
  it("sent, rejected and failed are terminal", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["failed", "rejected", "sent"]);
    for (const status of ["sent", "rejected", "failed"] as const) {
      expect(isTerminal(status)).toBe(true);
    }
  });

  it("created and queued are not terminal", () => {
    expect(isTerminal("created")).toBe(false);
    expect(isTerminal("queued")).toBe(false);
  });

  it("created and queued are the deliverable statuses", () => {
    expect([...DELIVERABLE_STATUSES]).toEqual(["created", "queued"]);
  });

  it("every status is either terminal or deliverable, never both", () => {
    for (const status of REQUEST_STATUSES) {
      const deliverable = DELIVERABLE_STATUSES.some((s) => s === status);
      expect(deliverable).toBe(!isTerminal(status));
    }
  });
});

describe("allowedPreviousStatuses", () => {
  it("queued is set only from created", () => {
    expect(allowedPreviousStatuses("queued")).toEqual(["created"]);
  });

  it.each(["sent", "rejected", "failed"] as const)(
    "%s is set only from created or queued (the worker can be faster than the enqueuer)",
    (target) => {
      expect([...allowedPreviousStatuses(target)].sort()).toEqual(["created", "queued"]);
    },
  );

  it("created can never be set again", () => {
    expect(allowedPreviousStatuses("created")).toEqual([]);
  });

  it("no status may be changed away from a terminal status", () => {
    for (const target of REQUEST_STATUSES) {
      for (const terminal of TERMINAL_STATUSES) {
        expect(allowedPreviousStatuses(target)).not.toContain(terminal);
      }
    }
  });

  it("a status is never allowed to follow itself", () => {
    for (const target of REQUEST_STATUSES) {
      expect(allowedPreviousStatuses(target)).not.toContain(target);
    }
  });
});
