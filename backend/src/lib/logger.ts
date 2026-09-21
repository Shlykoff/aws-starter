import type { LogLevel } from "./config";
import { LogGuardError, sanitizeFields, sanitizeMessage } from "./log-fields";

// Minimal structured logger: one JSON object per line, so CloudWatch Logs Insights can
// filter on any field. No timestamp field: CloudWatch stamps every log event itself.
//
// Every line passes the guard of lib/log-fields.ts: only fields on the list get through, each
// with a value of its shape. The old rule (log identifiers, counts and outcomes, never bodies,
// tokens or the raw event) is now enforced here as well as followed by the callers.

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line it writes, for example the request id. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /**
   * What happens when the guard has to replace something. In strict mode it throws, so a test
   * (or a developer running the code) sees a wrong log call at once. Otherwise the line is
   * written with the replacement and the function goes on: logging must never break a handler.
   * Default: strict when the environment variable LOG_STRICT is "1" (the tests set it).
   */
  strict?: boolean;
}

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(minLevel: LogLevel, baseFields: LogFields = {}, options: LoggerOptions = {}): Logger {
  const strict = options.strict ?? process.env.LOG_STRICT === "1";

  const write = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    if (SEVERITY[level] < SEVERITY[minLevel]) return;

    const checkedMessage = sanitizeMessage(message);
    const checkedFields = sanitizeFields({ ...baseFields, ...fields });
    const problems = [...(checkedMessage.problem === undefined ? [] : [checkedMessage.problem]), ...checkedFields.problems];
    if (strict && problems.length > 0) throw new LogGuardError(problems.join("; "));

    // The matching console method lets Lambda tag the line with the right log level.
    console[level](JSON.stringify({ level, message: checkedMessage.message, ...checkedFields.fields }));
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (fields) => createLogger(minLevel, { ...baseFields, ...fields }, { strict }),
  };
}
