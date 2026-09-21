import { SpanStatusCode, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogGuardError } from "../../src/lib/log-fields";
import {
  contextFromTraceparent,
  currentTraceId,
  currentTraceparent,
  startSpan,
  toXRayTraceHeader,
  tracedPort,
  withSpan,
} from "../../src/lib/tracing";
import {
  STORED_SPAN_ID,
  STORED_TRACEPARENT,
  STORED_TRACE_ID,
  parentIdOf,
  recordSpans,
  traceparentOf,
  wholeSpan,
} from "../helpers/tracing";

// A text that must never reach a span: it stands for a request text, a partner name or the message
// of a parser that quotes its input.
const CANARY = "canary-Please-ship-42-Acme";

describe("without an SDK (the tests, a local run): every call does nothing", () => {
  it("withSpan gives back what the function gives, and an error unchanged", async () => {
    expect(await withSpan("x", { requestId: "r1" }, () => 42)).toBe(42);
    expect(await withSpan("x", {}, async () => Promise.resolve("later"))).toBe("later");

    const failure = new Error("boom");
    await expect(withSpan("x", {}, () => Promise.reject(failure))).rejects.toBe(failure);
  });

  it("has no traceparent and no trace id, and a span that is opened and ended has none either", () => {
    expect(currentTraceparent()).toBeUndefined();
    expect(currentTraceId()).toBeUndefined();

    const span = startSpan("x", {});
    expect(span.traceparent).toBeUndefined();
    expect(span.run(() => currentTraceparent())).toBeUndefined();
    span.fail(new Error("boom"));
    span.end();
  });

  it("tracedPort behaves like the port it wraps", async () => {
    const port = tracedPort({ ping: () => Promise.resolve("pong"), plain: () => 7 }, "port");

    expect(await port.ping()).toBe("pong");
    expect(port.plain()).toBe(7);
  });
});

describe("withSpan", () => {
  const spans = recordSpans();

  it("records one ended span with its name and attributes, and gives back the result", async () => {
    const result = await withSpan("create request", { requestId: "r1", attempt: 2 }, () => "done");

    expect(result).toBe("done");
    const span = spans.only("create request");
    expect(span.attributes).toEqual({ requestId: "r1", attempt: 2 });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.ended).toBe(true);
  });

  it("makes its span the active one, also after an await, and it is not active outside", async () => {
    let inside: string | undefined;
    await withSpan("active", {}, async () => {
      await Promise.resolve();
      inside = currentTraceparent();
    });

    expect(inside).toBe(traceparentOf(spans.only("active")));
    expect(currentTraceparent()).toBeUndefined();
  });

  it("nests: a span started inside another one has it as parent, in the same trace", async () => {
    await withSpan("outer", {}, async () => {
      await Promise.resolve();
      await withSpan("inner", {}, () => undefined);
    });

    const outer = spans.only("outer");
    const inner = spans.only("inner");
    expect(parentIdOf(inner)).toBe(outer.spanContext().spanId);
    expect(inner.spanContext().traceId).toBe(outer.spanContext().traceId);
    expect(parentIdOf(outer)).toBeUndefined();
  });

  it("uses the parent it is given, and the start time it is given", async () => {
    const parent = contextFromTraceparent(STORED_TRACEPARENT);
    const startTime = Date.now() - 5000;

    await withSpan("late", {}, () => undefined, { ...(parent !== undefined && { parent }), startTime });

    const span = spans.only("late");
    expect(parentIdOf(span)).toBe(STORED_SPAN_ID);
    expect(span.spanContext().traceId).toBe(STORED_TRACE_ID);
    const durationMs = span.duration[0] * 1000 + span.duration[1] / 1e6;
    expect(durationMs).toBeGreaterThanOrEqual(5000);
    expect(durationMs).toBeLessThan(6000);
  });

  it("ends the span and throws the same error again when the function fails", async () => {
    const failure = new TypeError(`cannot read ${CANARY}`);

    await expect(withSpan("call", { requestId: "r1" }, () => Promise.reject(failure))).rejects.toBe(failure);

    const span = spans.only("call");
    expect(span.ended).toBe(true);
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: "TypeError" });
    expect(span.attributes).toEqual({ requestId: "r1", errorName: "TypeError" });
  });

  it("records an error by its type only: never its message, its stack or an exception event", async () => {
    const failure = new Error(`Unexpected token '${CANARY}' in JSON`);
    failure.stack = `Error: ${CANARY}\n    at somewhere`;

    await expect(withSpan("call", {}, () => Promise.reject(failure))).rejects.toThrow();

    const span = spans.only("call");
    expect(span.events).toEqual([]);
    expect(wholeSpan(span)).not.toContain(CANARY);
    expect(wholeSpan(span)).not.toContain("somewhere");
  });

  it("does not record an error name that is not a plain word, and names a thrown non-error", async () => {
    const strange = new Error("x");
    strange.name = `Error: ${CANARY}`;

    await expect(withSpan("a", {}, () => Promise.reject(strange))).rejects.toThrow();
    await expect(
      withSpan("b", {}, () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- a library may throw anything
        throw CANARY;
      }),
    ).rejects.toBe(CANARY);

    expect(spans.only("a").status.message).toBe("Error");
    expect(spans.only("b").status.message).toBe("NonError");
    expect(wholeSpan(spans.only("a"))).not.toContain(CANARY);
    expect(wholeSpan(spans.only("b"))).not.toContain(CANARY);
  });

  it("marks a synchronous throw as failed too", async () => {
    await expect(
      withSpan("sync", {}, () => {
        throw new RangeError("nope");
      }),
    ).rejects.toThrow("nope");

    expect(spans.only("sync").status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe("the attributes of a span pass the guard of the log fields", () => {
  const spans = recordSpans();
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("in a Lambda (not strict): what is not allowed is dropped", () => {
    it("drops an attribute that is not on the list, and one whose value has the wrong shape", async () => {
      vi.stubEnv("LOG_STRICT", "");

      await withSpan("guarded", { requestId: "r1", subject: CANARY, partner: "Acme", attempt: "three", httpStatus: 200 }, () => undefined);

      // "attempt" must be a number, "subject" and "partner" are not on the list at all.
      expect(spans.only("guarded").attributes).toEqual({ requestId: "r1", httpStatus: 200 });
      expect(wholeSpan(spans.only("guarded"))).not.toContain(CANARY);
    });

    it("drops a value of the wrong shape that is set later, and leaves an undefined one out", async () => {
      vi.stubEnv("LOG_STRICT", "");

      await withSpan("later", {}, (span) => {
        span.setAttributes({ decision: "has a space", partnerMs: 12, httpStatus: undefined, body: CANARY });
      });

      expect(spans.only("later").attributes).toEqual({ partnerMs: 12 });
    });

    it("keeps an attribute of a list shape (a list of words)", async () => {
      await withSpan("list", { elements: ["Subject", "Body"] }, () => undefined);

      expect(spans.only("list").attributes).toEqual({ elements: ["Subject", "Body"] });
    });
  });

  describe("in strict mode (LOG_STRICT=1, as in the tests): it throws, like the logger", () => {
    it("throws at the start, before any span exists", async () => {
      await expect(withSpan("strict", { subject: CANARY }, () => undefined)).rejects.toBeInstanceOf(LogGuardError);
      expect(spans.all()).toEqual([]);
      expect(() => startSpan("strict", { requestId: "has space" })).toThrow(LogGuardError);
    });

    it("throws for an attribute set later, and the span is then marked as failed", async () => {
      await expect(
        withSpan("strict-later", {}, (span) => {
          span.setAttributes({ reason: `free text ${CANARY}` });
        }),
      ).rejects.toBeInstanceOf(LogGuardError);

      expect(spans.only("strict-later").status).toEqual({ code: SpanStatusCode.ERROR, message: "LogGuardError" });
      expect(wholeSpan(spans.only("strict-later"))).not.toContain(CANARY);
    });
  });
});

describe("the traceparent", () => {
  const spans = recordSpans();

  it("round trip: the traceparent of a span gives a context that has that span as parent", async () => {
    let traceparent: string | undefined;
    let traceId: string | undefined;
    await withSpan("origin", {}, () => {
      traceparent = currentTraceparent();
      traceId = currentTraceId();
    });

    const origin = spans.only("origin");
    expect(traceparent).toBe(traceparentOf(origin));
    expect(traceId).toBe(origin.spanContext().traceId);
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    const parent = contextFromTraceparent(traceparent);
    expect(parent).toBeDefined();
    const spanContext = trace.getSpanContext(parent ?? (undefined as never));
    expect(spanContext).toMatchObject({
      traceId: origin.spanContext().traceId,
      spanId: origin.spanContext().spanId,
      isRemote: true,
      traceFlags: 1,
    });
  });

  it("keeps the flags: an unsampled traceparent stays unsampled", () => {
    const context = contextFromTraceparent(`00-${STORED_TRACE_ID}-${STORED_SPAN_ID}-00`);

    expect(trace.getSpanContext(context ?? (undefined as never))?.traceFlags).toBe(0);
  });

  const GARBAGE: [string, unknown][] = [
    ["upper case", STORED_TRACEPARENT.toUpperCase()],
    ["a trace id that is too short", `00-${STORED_TRACE_ID.slice(1)}-${STORED_SPAN_ID}-01`],
    ["a trace id that is too long", `00-${STORED_TRACE_ID}0-${STORED_SPAN_ID}-01`],
    ["a span id that is too short", `00-${STORED_TRACE_ID}-${STORED_SPAN_ID.slice(1)}-01`],
    ["an all-zero trace id", `00-${"0".repeat(32)}-${STORED_SPAN_ID}-01`],
    ["an all-zero span id", `00-${STORED_TRACE_ID}-${"0".repeat(16)}-01`],
    ["another version", `01-${STORED_TRACE_ID}-${STORED_SPAN_ID}-01`],
    ["a version that is not allowed", `ff-${STORED_TRACE_ID}-${STORED_SPAN_ID}-01`],
    ["no flags", `00-${STORED_TRACE_ID}-${STORED_SPAN_ID}`],
    ["flags of one digit", `00-${STORED_TRACE_ID}-${STORED_SPAN_ID}-1`],
    ["an extra field", `${STORED_TRACEPARENT}-extra`],
    ["a trailing space", `${STORED_TRACEPARENT} `],
    ["a line break at the end", `${STORED_TRACEPARENT}\n`],
    ["a character that is not hex", `00-${"g".repeat(32)}-${STORED_SPAN_ID}-01`],
    ["an empty string", ""],
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { traceparent: STORED_TRACEPARENT }],
  ];

  it.each(GARBAGE)("is not a trace: %s", (_name, value) => {
    expect(contextFromTraceparent(value)).toBeUndefined();
    expect(toXRayTraceHeader(value as string | undefined)).toBeUndefined();
  });

  it("gives the X-Ray header for a vector computed by hand", () => {
    // The example of the X-Ray documentation: trace id 1-5759e988-bd862e3fe1be46a994272793.
    const traceparent = "00-5759e988bd862e3fe1be46a994272793-53995c3f42cd8ad8-01";

    expect(toXRayTraceHeader(traceparent)).toBe(
      "Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1",
    );
    expect(toXRayTraceHeader("00-5759e988bd862e3fe1be46a994272793-53995c3f42cd8ad8-00")).toBe(
      "Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=0",
    );
    // Only the lowest flag bit is "sampled".
    expect(toXRayTraceHeader("00-5759e988bd862e3fe1be46a994272793-53995c3f42cd8ad8-02")).toContain("Sampled=0");
    expect(toXRayTraceHeader("00-5759e988bd862e3fe1be46a994272793-53995c3f42cd8ad8-03")).toContain("Sampled=1");
  });
});

describe("tracedPort", () => {
  const spans = recordSpans();

  // The arguments are there to be passed and never used: the point is that no span records them.
  /* eslint-disable @typescript-eslint/no-unused-vars */
  class Store {
    private readonly name = "the-store";
    save(_id: string, _body: unknown): Promise<string> {
      return Promise.resolve(`saved in ${this.name}`);
    }
    fail(_secret: string): Promise<never> {
      return Promise.reject(new SyntaxError(`bad ${CANARY}`));
    }
    forget(): void {
      // a method that returns nothing
    }
    readonly kind = "store";
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  it("makes a span named <label>.<method> for every call, and the method still works on its own object", async () => {
    const store = tracedPort(new Store(), "exchanges");

    expect(await store.save("r1", { text: CANARY })).toBe("saved in the-store");
    await expect(store.fail(CANARY)).rejects.toBeInstanceOf(SyntaxError);

    expect(spans.all().map((span) => span.name)).toEqual(["exchanges.save", "exchanges.fail"]);
  });

  it("never records an argument, a result or an error message", async () => {
    const store = tracedPort(new Store(), "exchanges");

    await store.save(CANARY, { text: CANARY });
    await expect(store.fail(CANARY)).rejects.toThrow();

    for (const span of spans.all()) {
      expect(span.attributes).toEqual(span.name === "exchanges.fail" ? { errorName: "SyntaxError" } : {});
      expect(wholeSpan(span)).not.toContain(CANARY);
    }
    expect(spans.only("exchanges.fail").status).toEqual({ code: SpanStatusCode.ERROR, message: "SyntaxError" });
  });

  it("keeps the span open until the promise settles", async () => {
    let finish: (value: string) => void = () => undefined;
    const port = tracedPort({ slow: () => new Promise<string>((resolve) => (finish = resolve)) }, "port");

    const pending = port.slow();
    expect(spans.all()).toEqual([]);

    finish("ok");
    expect(await pending).toBe("ok");
    expect(spans.all().map((span) => span.name)).toEqual(["port.slow"]);
  });

  it("passes a property that is not a method, and the result of a method that returns no promise, as they are", () => {
    const store = tracedPort(new Store(), "exchanges");

    expect(store.kind).toBe("store");
    expect(store.forget()).toBeUndefined();
  });

  it("makes the span of the call the active one, so spans of the code it calls are its children", async () => {
    const port = tracedPort({ work: () => withSpan("inside", {}, () => undefined) }, "port");

    await port.work();

    expect(parentIdOf(spans.only("inside"))).toBe(spans.only("port.work").spanContext().spanId);
  });

  it("ends the span and throws again when the method throws at once", () => {
    const port = tracedPort(
      {
        broken: (): Promise<void> => {
          throw new RangeError("at once");
        },
      },
      "port",
    );

    expect(() => port.broken()).toThrow("at once");
    expect(spans.only("port.broken").status.code).toBe(SpanStatusCode.ERROR);
  });
});
