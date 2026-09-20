import { vi } from "vitest";

// Captures what the logger writes (it uses console.debug/info/warn/error) so that tests
// can assert on it and the test output stays quiet. `restoreMocks` in vitest.config.ts
// puts the real console back after every test.
export function captureLogs(): { lines: string[]; entries: () => Record<string, unknown>[] } {
  const lines: string[] = [];
  for (const method of ["debug", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
  }
  return {
    lines,
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
