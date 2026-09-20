import { useEffect, useEffectEvent, useRef } from "react";

// Calls `refresh` every `intervalMs` milliseconds for as long as `enabled` is true.
// Nothing is called right away: the page has just loaded its data itself.
//
//   - No overlap: while a refresh is still running, the next tick is skipped.
//   - A hidden browser tab does not poll. When the tab becomes visible again it refreshes
//     once immediately and restarts the interval.
//   - `enabled` turning false, or the component unmounting, stops everything.
//   - `refresh` should handle its own errors. Whatever it still throws is swallowed here:
//     one failed refresh must not stop the polling.
export function usePolling(refresh: () => Promise<unknown>, intervalMs: number, enabled: boolean): void {
  // Always the newest `refresh`, yet not a dependency of the effect below. Without this,
  // the inline arrow function a page passes in is new on every render and would restart
  // the timer each time.
  const refreshLatest = useEffectEvent(refresh);
  // A ref and not a variable inside the effect: the effect restarts when `enabled` or the
  // interval changes, and a refresh that is still running must block the new timer too.
  const running = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    async function tick() {
      if (running.current) return;
      running.current = true;
      try {
        await refreshLatest();
      } catch {
        // Deliberately ignored, see the comment at the top.
      } finally {
        running.current = false;
      }
    }

    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      timer = setInterval(() => void tick(), intervalMs);
    };
    const stop = () => clearInterval(timer);

    function handleVisibilityChange() {
      stop();
      if (document.visibilityState === "hidden") return;
      void tick();
      start();
    }

    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, intervalMs]);
}
