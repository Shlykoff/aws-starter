// "2025-01-31T09:05:00.000Z" -> "Jan 31, 2025, 1:05:00 PM GMT+4" in the user's own locale and
// time zone. The API sends UTC (ISO 8601); people expect local time, and the zone is named so
// that nobody has to guess which one it is.
//
// The recipient's inbox (partner-sim, LOCAL_TIME_SCRIPT in app/ui.py) shows its times with these
// same options, so the same moment reads the same in both applications. Component options are
// used, not dateStyle/timeStyle: those cannot be combined with a time zone name. Seconds are
// shown because two systems are compared moment by moment.
const formatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  // A malformed value should not crash the page; show it as it came.
  return Number.isNaN(date.getTime()) ? iso : formatter.format(date);
}
