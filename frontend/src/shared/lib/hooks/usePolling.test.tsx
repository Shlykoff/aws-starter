import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePolling } from "./usePolling";

const INTERVAL = 5_000;

// jsdom has no real tab, so the tests decide what the page visibility is and tell the hook
// the same way a browser does: change the value, then fire `visibilitychange`.
let visibility: DocumentVisibilityState;
function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("usePolling", () => {
  it("calls the callback once per interval while enabled, and not before the first interval", async () => {
    const refresh = vi.fn(() => Promise.resolve());
    renderHook(() => usePolling(refresh, INTERVAL, true));

    await advance(INTERVAL - 1);
    expect(refresh).not.toHaveBeenCalled();

    await advance(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    await advance(INTERVAL * 2);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("does not poll while disabled, starts when enabled and stops when disabled again", async () => {
    const refresh = vi.fn(() => Promise.resolve());
    const { rerender } = renderHook(({ enabled }) => usePolling(refresh, INTERVAL, enabled), {
      initialProps: { enabled: false },
    });

    await advance(INTERVAL * 3);
    expect(refresh).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await advance(INTERVAL);
    expect(refresh).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    await advance(INTERVAL * 3);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not start a new refresh while the previous one is still running", async () => {
    let finish: () => void = () => undefined;
    const refresh = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    renderHook(() => usePolling(refresh, INTERVAL, true));

    await advance(INTERVAL * 4);
    expect(refresh).toHaveBeenCalledTimes(1);

    finish();
    await advance(INTERVAL);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("pauses while the tab is hidden and refreshes once when it is visible again", async () => {
    const refresh = vi.fn(() => Promise.resolve());
    renderHook(() => usePolling(refresh, INTERVAL, true));

    setVisibility("hidden");
    await advance(INTERVAL * 4);
    expect(refresh).not.toHaveBeenCalled();

    setVisibility("visible");
    await advance(0);
    expect(refresh).toHaveBeenCalledTimes(1);

    // The regular rhythm continues from the moment the tab came back.
    await advance(INTERVAL);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does not start a refresh on becoming visible while one is still running", async () => {
    let finish: () => void = () => undefined;
    const refresh = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    renderHook(() => usePolling(refresh, INTERVAL, true));
    await advance(INTERVAL);

    setVisibility("hidden");
    setVisibility("visible");
    await advance(0);
    expect(refresh).toHaveBeenCalledTimes(1);

    finish();
  });

  it("does not poll when it is enabled while the tab is hidden, until the tab is visible", async () => {
    visibility = "hidden";
    const refresh = vi.fn(() => Promise.resolve());
    renderHook(() => usePolling(refresh, INTERVAL, true));

    await advance(INTERVAL * 3);
    expect(refresh).not.toHaveBeenCalled();

    setVisibility("visible");
    await advance(0);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps polling after a refresh failed", async () => {
    const refresh = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("boom")).mockResolvedValue();
    renderHook(() => usePolling(refresh, INTERVAL, true));

    await advance(INTERVAL);
    await advance(INTERVAL);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("uses the newest callback without restarting the timer", async () => {
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    const { rerender } = renderHook(({ refresh }) => usePolling(refresh, INTERVAL, true), {
      initialProps: { refresh: first },
    });

    await advance(INTERVAL - 1000);
    rerender({ refresh: second });
    // Had the timer restarted, this would only be 1000 ms into a new interval.
    await advance(1000);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops the timer and the visibility listener when the component unmounts", async () => {
    const refresh = vi.fn(() => Promise.resolve());
    const { unmount } = renderHook(() => usePolling(refresh, INTERVAL, true));

    unmount();
    await advance(INTERVAL * 3);
    setVisibility("hidden");
    setVisibility("visible");
    await advance(0);

    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
