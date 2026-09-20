import type { LogLevel } from "./config";

// Minimal structured logger: one JSON object per line, so CloudWatch Logs Insights can
// filter on any field. No timestamp field: CloudWatch stamps every log event itself.
//
// Rule for callers: log identifiers, counts and outcomes, never request bodies, tokens or
// the raw event. (A redaction helper for sensitive fields is planned for stage 3.)

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line it writes, for example the request id. */
  child(fields: LogFields): Logger;
}

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(minLevel: LogLevel, baseFields: LogFields = {}): Logger {
  const write = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    if (SEVERITY[level] < SEVERITY[minLevel]) return;
    // The matching console method lets Lambda tag the line with the right log level.
    console[level](JSON.stringify({ level, message, ...baseFields, ...fields }));
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (fields) => createLogger(minLevel, { ...baseFields, ...fields }),
  };
}
