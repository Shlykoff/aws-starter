import { SpanStatusCode } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { EnqueueService } from "../../src/services/enqueue-service";
import type { EnqueueEntry } from "../../src/services/enqueue-service";
import { createLogger } from "../../src/lib/logger";
import { tracedPort, withSpan } from "../../src/lib/tracing";
import {
  FakeDeliveryQueue,
  FakeDeliveryRepository,
  aRequest,
} from "../helpers/fakes";
import type { Journal } from "../helpers/fakes";
import { captureLogs } from "../helpers/logs";
import { STORED_SPAN_ID, STORED_TRACEPARENT, STORED_TRACE_ID, parentIdOf, recordSpans } from "../helpers/tracing";

// Reference values computed outside the code: printf 'acme' | shasum -a 256
const ACME_GROUP = "822b33ad87c148a0a20a5ba7cd5ebcaa68d36a18e7aad165554903f52ca82757";
const GLOBEX_GROUP = "5bc1a08d28e40fe79ca3ecb077b3bd14ff00df9bad0c4a0d74ecd0805ecf0b1f";

const idNumber = (n: number): string => `01J8Z3K5W0ABCDEFGHJKMN${String(n).padStart(4, "0")}`;

function entry(n: number, partner = "Acme", ownerId = "user-a", retryCount = 0): EnqueueEntry {
  return { key: `seq-${n}`, request: { requestId: idNumber(n), ownerId, partner, retryCount } };
}

function setup(requestCount = 0) {
  const journal: Journal = [];
  const queue = new FakeDeliveryQueue(journal);
  const repository = new FakeDeliveryRepository(journal);
  for (let n = 1; n <= requestCount; n++) repository.seed(aRequest({ id: idNumber(n), status: "created" }));
  const logs = captureLogs();
  const service = new EnqueueService(queue, repository);
  const enqueue = (entries: EnqueueEntry[]) => service.enqueue(entries, createLogger("debug"));
  return { journal, queue, repository, logs, enqueue };
}

describe("EnqueueService: the message", () => {
  it("sends the two ids as the body, the partner hash as group id and the request id as deduplication id", async () => {
    const { queue, enqueue } = setup(1);

    await enqueue([entry(1, "Acme")]);

    expect(queue.calls).toEqual([
      [
        {
          id: "seq-1",
          body: JSON.stringify({ requestId: idNumber(1), ownerId: "user-a" }),
          groupId: ACME_GROUP,
          deduplicationId: idNumber(1),
        },
      ],
    ]);
  });

  it("sends a request that was sent again with its own deduplication id: <requestId>-r<retryCount>", async () => {
    const { queue, enqueue } = setup(2);

    await enqueue([entry(1, "Acme", "user-a", 1), entry(2, "Acme", "user-a", 12)]);

    // The body and the group are those of a first send; only the deduplication id differs,
    // so the queue does not take the message for a duplicate of the first one.
    expect(queue.calls[0]?.map((message) => message.deduplicationId)).toEqual([
      `${idNumber(1)}-r1`,
      `${idNumber(2)}-r12`,
    ]);
    expect(queue.calls[0]?.map((message) => message.groupId)).toEqual([ACME_GROUP, ACME_GROUP]);
    expect(queue.calls[0]?.[0]?.body).toBe(JSON.stringify({ requestId: idNumber(1), ownerId: "user-a" }));
  });

  it("puts the same partner in the same group however it is spelled, and other partners elsewhere", async () => {
    const { queue, enqueue } = setup(3);

    await enqueue([entry(1, "Acme"), entry(2, "  ACME "), entry(3, "Globex")]);

    expect(queue.calls[0]?.map((message) => message.groupId)).toEqual([
      ACME_GROUP,
      ACME_GROUP,
      GLOBEX_GROUP,
    ]);
  });

  it("puts no request text and no partner name into the message", async () => {
    const { queue, enqueue } = setup(1);

    await enqueue([entry(1, "Acme")]);

    const body = queue.calls[0]?.[0]?.body ?? "";
    expect(body).not.toContain("Acme");
    expect(Object.keys(JSON.parse(body) as object).sort()).toEqual(["ownerId", "requestId"]);
  });
});

describe("EnqueueService: order of the steps and batching", () => {
  it("marks a request as queued only after its message was sent", async () => {
    const { journal, enqueue } = setup(2);

    await enqueue([entry(1), entry(2)]);

    expect(journal).toEqual(["queue.send", "repo.markQueued", "repo.markQueued"]);
  });

  it("marks the request as queued (created -> queued)", async () => {
    const { repository, enqueue } = setup(1);

    const result = await enqueue([entry(1)]);

    expect(repository.statusOf(idNumber(1))).toBe("queued");
    expect(result).toEqual({ failedKeys: [], sent: 1, queued: 1, alreadyMoved: 0 });
  });

  it("sends at most 10 messages per call and keeps the order", async () => {
    const { queue, enqueue } = setup(25);
    const entries = Array.from({ length: 25 }, (_, i) => entry(i + 1));

    const result = await enqueue(entries);

    expect(queue.calls.map((call) => call.length)).toEqual([10, 10, 5]);
    expect(queue.calls.flat().map((message) => message.id)).toEqual(entries.map((e) => e.key));
    expect(result.sent).toBe(25);
    expect(result.failedKeys).toEqual([]);
  });

  it("sends exactly 10 messages in one call", async () => {
    const { queue, enqueue } = setup(10);

    await enqueue(Array.from({ length: 10 }, (_, i) => entry(i + 1)));

    expect(queue.calls.map((call) => call.length)).toEqual([10]);
  });

  it("does nothing for an empty batch", async () => {
    const { journal, enqueue } = setup();

    expect(await enqueue([])).toEqual({ failedKeys: [], sent: 0, queued: 0, alreadyMoved: 0 });
    expect(journal).toEqual([]);
  });
});

describe("EnqueueService: when the status already moved on", () => {
  it("treats a lost conditional update as done, not as a failure", async () => {
    const { repository, enqueue } = setup(1);
    repository.setStatus(idNumber(1), "sent"); // the worker was faster

    const result = await enqueue([entry(1)]);

    expect(result).toEqual({ failedKeys: [], sent: 1, queued: 0, alreadyMoved: 1 });
    expect(repository.statusOf(idNumber(1))).toBe("sent");
  });
});

describe("EnqueueService: failures", () => {
  it("reports only the records whose message SQS refused, and marks only the others as queued", async () => {
    const { queue, repository, journal, enqueue } = setup(3);
    queue.refuse.add("seq-2");

    const result = await enqueue([entry(1), entry(2), entry(3)]);

    expect(result.failedKeys).toEqual(["seq-2"]);
    expect(repository.statusOf(idNumber(1))).toBe("queued");
    expect(repository.statusOf(idNumber(2))).toBe("created");
    expect(repository.statusOf(idNumber(3))).toBe("queued");
    expect(journal).toEqual(["queue.send", "repo.markQueued", "repo.markQueued"]);
    expect(result).toMatchObject({ sent: 2, queued: 2 });
  });

  it("reports every record of a call that failed as a whole, and still handles the other calls", async () => {
    const { queue, repository, enqueue } = setup(12);
    queue.failCalls.set(0, new Error("SQS is down"));

    const result = await enqueue(Array.from({ length: 12 }, (_, i) => entry(i + 1)));

    // The first call had records 1-10; the second one (11-12) went through.
    expect(result.failedKeys).toEqual(Array.from({ length: 10 }, (_, i) => `seq-${i + 1}`));
    expect(repository.statusOf(idNumber(1))).toBe("created");
    expect(repository.statusOf(idNumber(11))).toBe("queued");
    expect(repository.statusOf(idNumber(12))).toBe("queued");
  });

  it("reports a record whose markQueued fails, and goes on with the next one", async () => {
    const { repository, enqueue } = setup(2);
    repository.failures.set("markQueued", new Error("throttled"));

    const result = await enqueue([entry(1), entry(2)]);

    expect(result.failedKeys).toEqual(["seq-1", "seq-2"]);
    expect(result.sent).toBe(2); // both messages were sent; the retry will send them again
  });

  it("logs the failure without the request text", async () => {
    const { queue, logs, enqueue } = setup(1);
    queue.failCalls.set(0, new Error("SQS is down"));

    await enqueue([entry(1, "Acme")]);

    const failure = logs.entries().find((line) => line.message === "SendMessageBatch failed");
    expect(failure).toMatchObject({ level: "error", errorName: "Error", errorMessage: "SQS is down" });
    expect(logs.lines.join("\n")).not.toContain("Acme");
  });
});

// The request event of docs/api.md ("Logs", "Request events"): written per request, and only for
// a request that THIS call moved from created to queued.
describe("EnqueueService: request events", () => {
  const requestEvents = (logs: ReturnType<typeof captureLogs>) =>
    logs.entries().filter((line) => line.message === "Request event");

  it("request_queued: once per moved request, with exactly its fields", async () => {
    const { logs, enqueue } = setup(2);

    await enqueue([entry(1), entry(2)]);

    expect(requestEvents(logs)).toEqual(
      [1, 2].map((n) => ({
        level: "info",
        message: "Request event",
        event: "request_queued",
        role: "enqueuer",
        requestId: idNumber(n),
        fromStatus: "created",
        toStatus: "queued",
      })),
    );
  });

  it("is not written for a request that was no longer created (the worker was faster)", async () => {
    const { repository, logs, enqueue } = setup(2);
    repository.setStatus(idNumber(1), "sent");

    await enqueue([entry(1), entry(2)]);

    expect(requestEvents(logs).map((line) => line.requestId)).toEqual([idNumber(2)]);
  });

  it("is not written for a message SQS refused, or when markQueued throws", async () => {
    const { queue, repository, logs, enqueue } = setup(3);
    queue.refuse.add("seq-1");
    repository.failures.set("markQueued", new Error("throttled"));

    await enqueue([entry(1), entry(2), entry(3)]);

    expect(requestEvents(logs)).toEqual([]);
  });
});

// The trace of a request (lib/tracing.ts): a span per request in the trace that is stored with it,
// and the message hands that trace to the queue as the X-Ray trace header.
describe("EnqueueService: the trace of each request", () => {
  const spans = recordSpans();

  const withTrace = (n: number, traceparent: string | undefined): EnqueueEntry => {
    const plain = entry(n);
    return { ...plain, request: { ...plain.request, ...(traceparent !== undefined && { traceparent }) } };
  };
  const xray = (traceId: string, spanId: string) =>
    `Root=1-${traceId.slice(0, 8)}-${traceId.slice(8)};Parent=${spanId};Sampled=1`;

  it("makes one span `enqueue request` per request, a child of the stored span, and puts its trace into the message", async () => {
    const { queue, enqueue } = setup(1);

    await enqueue([withTrace(1, STORED_TRACEPARENT)]);

    const span = spans.only("enqueue request");
    expect(span.attributes).toMatchObject({ requestId: idNumber(1) });
    expect(parentIdOf(span)).toBe(STORED_SPAN_ID);
    expect(span.spanContext().traceId).toBe(STORED_TRACE_ID);
    // The parent of the worker's invocation will be THIS span, not the one that was stored.
    expect(queue.calls[0]?.[0]?.traceHeader).toBe(xray(STORED_TRACE_ID, span.spanContext().spanId));
  });

  it("keeps the requests of one batch apart: each has its own span, its own trace and its own header", async () => {
    const { queue, enqueue } = setup(2);
    const otherTrace = "00-11111111111111111111111111111111-2222222222222222-01";

    await enqueue([withTrace(1, STORED_TRACEPARENT), withTrace(2, otherTrace)]);

    expect(queue.calls).toHaveLength(1); // still one SendMessageBatch call
    const [first, second] = spans.named("enqueue request");
    expect(first?.spanContext().traceId).toBe(STORED_TRACE_ID);
    expect(second?.spanContext().traceId).toBe("11111111111111111111111111111111");
    expect(parentIdOf(second as NonNullable<typeof second>)).toBe("2222222222222222");
    expect(queue.calls[0]?.map((message) => message.traceHeader)).toEqual([
      xray(STORED_TRACE_ID, (first as NonNullable<typeof first>).spanContext().spanId),
      xray("11111111111111111111111111111111", (second as NonNullable<typeof second>).spanContext().spanId),
    ]);
  });

  it.each([
    ["no stored trace", undefined],
    ["a stored trace that is not valid", "00-not-a-trace"],
  ])("with %s: no parent from the request, the span belongs to the invocation's trace", async (_name, traceparent) => {
    const { queue, enqueue } = setup(1);

    await withSpan("invocation", {}, () => enqueue([withTrace(1, traceparent)]));

    const invocation = spans.only("invocation");
    const span = spans.only("enqueue request");
    expect(parentIdOf(span)).toBe(invocation.spanContext().spanId);
    expect(queue.calls[0]?.[0]?.traceHeader).toBe(xray(invocation.spanContext().traceId, span.spanContext().spanId));
  });

  it("keeps the span open until the request is marked, so that the update of the table is one of its spans", async () => {
    const journal: Journal = [];
    const queue = new FakeDeliveryQueue(journal);
    const repository = new FakeDeliveryRepository(journal);
    repository.seed(aRequest({ id: idNumber(1), status: "created" }));
    const service = new EnqueueService(queue, tracedPort(repository, "deliveries"));

    await service.enqueue([withTrace(1, STORED_TRACEPARENT)], createLogger("debug"));

    const span = spans.only("enqueue request");
    expect(parentIdOf(spans.only("deliveries.markQueued"))).toBe(span.spanContext().spanId);
    expect(span.attributes).toEqual({ requestId: idNumber(1), outcome: "queued" });
    expect(span.ended).toBe(true);
  });

  it("says what became of each request in the span, and ends every span whatever happens", async () => {
    const { queue, repository, enqueue } = setup(4);
    queue.refuse.add("seq-2"); // the queue refuses request 2
    repository.setStatus(idNumber(3), "sent"); // the worker was faster with request 3
    const markQueued = repository.markQueued;
    // Only the update of request 4 fails.
    repository.markQueued = (ownerId, id) =>
      id === idNumber(4) ? Promise.reject(new Error("throttled")) : markQueued(ownerId, id);

    await enqueue([entry(1), entry(2), entry(3), entry(4)]);

    const enqueueSpans = spans.named("enqueue request");
    expect(enqueueSpans.map((span) => span.attributes.outcome)).toEqual(["queued", "send_failed", "already_moved", "mark_failed"]);
    expect(enqueueSpans.every((span) => span.ended)).toBe(true);
    expect(enqueueSpans[3]?.status).toEqual({ code: SpanStatusCode.ERROR, message: "Error" });
    expect(enqueueSpans[0]?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("marks every span of a batch as failed when the whole call fails, by the type of the error only", async () => {
    const { queue, enqueue } = setup(2);
    queue.failCalls.set(0, new TypeError("SQS said canary-secret-text"));

    await enqueue([entry(1), entry(2)]);

    for (const span of spans.named("enqueue request")) {
      expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: "TypeError" });
      expect(span.attributes.outcome).toBe("send_failed");
      expect(JSON.stringify([span.attributes, span.status, span.events])).not.toContain("canary-secret-text");
    }
  });

  it("does not change the rest of the message: the body, the group and the deduplication id are those of a message without a trace", async () => {
    const { queue, enqueue } = setup(2);

    await enqueue([withTrace(1, STORED_TRACEPARENT), entry(2)]);

    const [traced, plain] = queue.calls[0] ?? [];
    const withoutHeader = ({ traceHeader, ...message }: NonNullable<typeof traced>) => {
      expect(traceHeader).toBeDefined();
      return message;
    };
    expect(withoutHeader(traced as NonNullable<typeof traced>)).toEqual({
      id: "seq-1",
      body: JSON.stringify({ requestId: idNumber(1), ownerId: "user-a" }),
      groupId: ACME_GROUP,
      deduplicationId: idNumber(1),
    });
    expect(withoutHeader(plain as NonNullable<typeof plain>)).toMatchObject({ id: "seq-2", groupId: ACME_GROUP });
  });
});

describe("EnqueueService without an SDK", () => {
  it("sends no trace header for a request without a stored trace", async () => {
    const { queue, enqueue } = setup(1);

    await enqueue([entry(1)]);

    expect(queue.calls[0]?.[0]).not.toHaveProperty("traceHeader");
  });

  it("hands on the stored trace as it is: the worker's invocation becomes a child of the creation", async () => {
    const { queue, enqueue } = setup(1);

    await enqueue([{ ...entry(1), request: { ...entry(1).request, traceparent: STORED_TRACEPARENT } }]);

    expect(queue.calls[0]?.[0]?.traceHeader).toBe(`Root=1-4bf92f35-77b34da6a3ce929d0e0e4736;Parent=${STORED_SPAN_ID};Sampled=1`);
  });
});
