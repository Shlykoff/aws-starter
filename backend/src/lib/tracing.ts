import { ROOT_CONTEXT, SpanStatusCode, context, trace } from "@opentelemetry/api";
import type { Attributes, AttributeValue, Context, SpanContext } from "@opentelemetry/api";
import { LogGuardError, REJECTED_TEXT, UNLISTED_TEXT, sanitizeFields } from "./log-fields";

// Tracing: one request is ONE trace, from the API call to the answer of the recipient.
//
// What is here and what is not:
//   - This file uses only the OpenTelemetry API (@opentelemetry/api). The SDK (the thing that
//     really records and exports spans) is not ours: the AWS-managed Lambda layer registers it
//     before the handler is loaded (infra). Where no SDK is registered (the tests, a local run)
//     every call below does nothing and returns the value the code would have without tracing.
//   - Lambda's own tracing makes one trace per invocation and joins the trace of a message that
//     SQS delivers. The DynamoDB stream and the HTTP webhook carry no trace, so the code carries
//     it: the request item stores a W3C `traceparent` (create-request, retry-request), the
//     enqueuer continues that trace and hands it to the queue in the message's AWSTraceHeader
//     (a system attribute of SQS), and the webhook records its span in that trace.
//
// What a span may hold: the same as a log line. Its attributes pass the guard of
// lib/log-fields.ts (a name on the list, a value of its shape), so no request text, partner name
// or reason can get into a trace. An error is recorded by its type only (`errorName`): never
// `recordException`, never the message, because parsers quote the input in their messages.

const TRACER_NAME = "aws-starter";

// --- The guard for attributes ---------------------------------------------------------------

interface CheckedAttributes {
  accepted: Attributes;
  problems: string[];
}

// Runs the attributes through the guard of the logger. A log line WRITES a replacement for a
// value it does not accept ("[unlisted]"); a span DROPS such an attribute.
function checkAttributes(attributes: Record<string, unknown>): CheckedAttributes {
  const { fields, problems } = sanitizeFields(attributes);
  const accepted: Attributes = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === UNLISTED_TEXT || value === REJECTED_TEXT) continue;
    // Every shape of log-fields.ts is a string, a number, a boolean or a list of strings.
    accepted[name] = value as AttributeValue;
  }
  return { accepted, problems };
}

// Like the logger, the strict mode (LOG_STRICT=1, the tests) throws, so that a wrong call is seen
// at once; in Lambda the attribute is dropped and the function goes on: tracing never breaks a handler.
function guardedAttributes(attributes: Record<string, unknown>): Attributes {
  const { accepted, problems } = checkAttributes(attributes);
  if (problems.length > 0 && process.env.LOG_STRICT === "1") throw new LogGuardError(problems.join("; "));
  return accepted;
}

// --- The W3C traceparent, "00-<trace id>-<span id>-<flags>" -----------------------------------
// Plain string work, no propagator package. Strict on purpose: the value comes out of the
// database, so anything that is not exactly this shape is not a trace and is ignored.

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ALL_ZEROS = /^0+$/;

interface Traceparent {
  traceId: string;
  spanId: string;
  traceFlags: number;
}

function parseTraceparent(value: unknown): Traceparent | undefined {
  if (typeof value !== "string") return undefined;
  const [, traceId, spanId, flags] = TRACEPARENT.exec(value) ?? [];
  if (traceId === undefined || spanId === undefined || flags === undefined) return undefined;
  // The W3C spec: an id of only zeros is invalid.
  if (ALL_ZEROS.test(traceId) || ALL_ZEROS.test(spanId)) return undefined;
  return { traceId, spanId, traceFlags: parseInt(flags, 16) };
}

// The value of a span context, checked by the same rule that reads it back.
function formatTraceparent(spanContext: SpanContext): string | undefined {
  const flags = spanContext.traceFlags.toString(16).padStart(2, "0");
  const text = `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
  return parseTraceparent(text) === undefined ? undefined : text;
}

/** The traceparent of the span that is active now, or `undefined` when there is none (no SDK, no span). */
export function currentTraceparent(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext === undefined ? undefined : formatTraceparent(spanContext);
}

/** The trace id (32 hex digits) of the active span, or `undefined`. It goes into the request events of the log. */
export function currentTraceId(): string | undefined {
  return parseTraceparent(currentTraceparent())?.traceId;
}

/**
 * A context whose "parent span" is the one named by a stored traceparent, to pass as
 * `parent` to `startSpan` / `withSpan`. `undefined` for anything that is not a valid traceparent
 * (a missing value, garbage, upper case, all-zero ids), so a bad value means "no parent", never an error.
 */
export function contextFromTraceparent(value: unknown): Context | undefined {
  const parsed = parseTraceparent(value);
  if (parsed === undefined) return undefined;
  return trace.setSpanContext(ROOT_CONTEXT, { ...parsed, isRemote: true });
}

/**
 * The same trace in the format of the AWSTraceHeader of SQS (X-Ray's "Root=...;Parent=...;Sampled=..."):
 * X-Ray's trace id is "1-" and the first 8 hex digits, "-", and the other 24. `undefined` for an
 * invalid traceparent.
 */
export function toXRayTraceHeader(traceparent: string | undefined): string | undefined {
  const parsed = parseTraceparent(traceparent);
  if (parsed === undefined) return undefined;
  const sampled = parsed.traceFlags & 1; // the lowest flag bit of W3C is "sampled"
  return `Root=1-${parsed.traceId.slice(0, 8)}-${parsed.traceId.slice(8)};Parent=${parsed.spanId};Sampled=${sampled}`;
}

// --- Spans -----------------------------------------------------------------------------------

export interface SpanOptions {
  /** The parent of the span. Default: the active span (none, without an SDK). */
  parent?: Context;
  /** When the work began, epoch milliseconds: for a span that is recorded after the work is done. */
  startTime?: number;
}

/** What the code inside `withSpan` may do with its span. */
export interface TracedSpan {
  /** Adds attributes, through the same guard as at the start. */
  setAttributes(attributes: Record<string, unknown>): void;
}

/**
 * A span that the caller ends itself. Only for the one place where a span must stay open over
 * several steps (the enqueuer); everything else uses `withSpan`.
 */
export interface OpenSpan extends TracedSpan {
  /** The traceparent of this span, to store or to hand on. `undefined` without an SDK. */
  readonly traceparent: string | undefined;
  /** Runs `fn` with this span active: spans started inside are its children. */
  run<T>(fn: () => T): T;
  /** Marks the span as failed, by the error's type only. */
  fail(error: unknown): void;
  end(): void;
}

// The type of an error, if it is a plain word (the shape of `errorName` in log-fields.ts).
function errorNameOf(error: unknown): string {
  const name = error instanceof Error ? error.name : "NonError";
  const accepted = checkAttributes({ errorName: name }).accepted.errorName;
  return typeof accepted === "string" ? accepted : "Error";
}

export function startSpan(name: string, attributes: Record<string, unknown>, options: SpanOptions = {}): OpenSpan {
  const checked = guardedAttributes(attributes);
  const parent = options.parent ?? context.active();
  // Asked for on every call, not kept at module level: the tracer provider is registered by the
  // layer (or by a test) after this module is loaded, and can be replaced.
  const span = trace.getTracer(TRACER_NAME).startSpan(name, { attributes: checked, startTime: options.startTime }, parent);
  const spanContext = trace.setSpan(parent, span);

  return {
    traceparent: formatTraceparent(span.spanContext()),
    setAttributes: (more) => span.setAttributes(guardedAttributes(more)),
    run: (fn) => context.with(spanContext, fn),
    fail: (error) => {
      const errorName = errorNameOf(error);
      span.setAttributes({ errorName });
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorName });
    },
    end: () => span.end(),
  };
}

/**
 * Runs `fn` inside a span and ends the span whatever happens. If `fn` throws, the span is marked
 * as failed (the type of the error only) and the error is thrown again, unchanged.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, unknown>,
  fn: (span: TracedSpan) => Promise<T> | T,
  options: SpanOptions = {},
): Promise<T> {
  const open = startSpan(name, attributes, options);
  try {
    return await open.run(() => fn(open));
  } catch (error) {
    open.fail(error);
    throw error;
  } finally {
    open.end();
  }
}

// --- Ports -----------------------------------------------------------------------------------

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

// One call of a method: a span around it, ended when the promise settles. A span is started
// BEFORE the call, because the spans that the layer makes for the AWS SDK and HTTP calls made
// inside it become its children. A method that does not return a promise gets an instant span.
function callInSpan(name: string, call: () => unknown): unknown {
  const open = startSpan(name, {});
  let result: unknown;
  try {
    result = open.run(call);
  } catch (error) {
    open.fail(error);
    open.end();
    throw error;
  }
  if (!isPromiseLike(result)) {
    open.end();
    return result;
  }
  return result.then(
    (value) => {
      open.end();
      return value;
    },
    (error: unknown) => {
      open.fail(error);
      open.end();
      throw error;
    },
  );
}

/**
 * Wraps a port (a repository, a client, a queue, a store) once, in its container: every call of
 * its methods becomes a span named `<label>.<method>`. No argument and no result is recorded.
 */
export function tracedPort<T extends object>(port: T, label: string): T {
  return new Proxy(port, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== "function" || typeof property !== "string" || property === "constructor") return member;
      // `target` is the real object, so the method sees its own fields (`this`), not the proxy.
      return (...args: unknown[]): unknown => callInSpan(`${label}.${property}`, () => Reflect.apply(member, target, args) as unknown);
    },
  });
}
