import { describe, expect, it } from "vitest";
import { EnqueueService } from "../../src/services/enqueue-service";
import type { EnqueueEntry } from "../../src/services/enqueue-service";
import { createLogger } from "../../src/lib/logger";
import {
  FakeDeliveryQueue,
  FakeDeliveryRepository,
  aRequest,
} from "../helpers/fakes";
import type { Journal } from "../helpers/fakes";
import { captureLogs } from "../helpers/logs";

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
