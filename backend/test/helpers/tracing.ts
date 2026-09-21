import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach } from "vitest";

// Real spans for the tests that need them. In production the AWS-managed Lambda layer registers
// the SDK; here a provider with an in-memory exporter does, and a context manager that keeps the
// active span across `await` (the same job as the layer's). It is registered before each test and
// removed after it, so every other test still runs with NO SDK, where every tracing call does
// nothing (which is how most of the suite, and a local run, behave).
//
// Call it inside a `describe`: it registers its own beforeEach / afterEach.
export interface RecordedSpans {
  /** Every span that has ended so far, in the order they ended. */
  all(): ReadableSpan[];
  /** The ended spans with this name. */
  named(name: string): ReadableSpan[];
  /** The one ended span with this name (fails the test if there are none or several). */
  only(name: string): ReadableSpan;
}

export function recordSpans(): RecordedSpans {
  let exporter = new InMemorySpanExporter();
  let provider: BasicTracerProvider | undefined;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });
  afterEach(async () => {
    trace.disable();
    context.disable();
    await provider?.shutdown();
    provider = undefined;
  });

  const all = (): ReadableSpan[] => exporter.getFinishedSpans();
  const named = (name: string): ReadableSpan[] => all().filter((span) => span.name === name);
  return {
    all,
    named,
    only: (name) => {
      const found = named(name);
      if (found.length !== 1) {
        throw new Error(`expected one span "${name}", found ${found.length} (all: ${all().map((s) => s.name).join(", ")})`);
      }
      return found[0] as ReadableSpan;
    },
  };
}

/** The W3C traceparent of a recorded span (flags 01: sampled). */
export const traceparentOf = (span: ReadableSpan): string => {
  const { traceId, spanId } = span.spanContext();
  return `00-${traceId}-${spanId}-01`;
};

/** The parent span's id of a recorded span, or undefined for a root. */
export const parentIdOf = (span: ReadableSpan): string | undefined => span.parentSpanContext?.spanId;

/** A fixed, valid traceparent that no span has: for a request that was stored with a trace. */
export const STORED_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
export const STORED_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
export const STORED_SPAN_ID = "00f067aa0ba902b7";

/** Everything a span holds, as one string: for "this text is nowhere in the span". */
export const wholeSpan = (span: ReadableSpan): string =>
  JSON.stringify({ name: span.name, attributes: span.attributes, status: span.status, events: span.events, links: span.links });
