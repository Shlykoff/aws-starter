// "2025-01-31T09:05:00.000Z" -> "31 Jan 2025, 10:05" in the user's own locale and time zone.
// The API sends UTC (ISO 8601); people expect local time.
const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  // A malformed value should not crash the page; show it as it came.
  return Number.isNaN(date.getTime()) ? iso : formatter.format(date);
}
