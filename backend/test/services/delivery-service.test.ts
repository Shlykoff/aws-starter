import { describe, expect, it } from "vitest";
import type { PartnerResult } from "../../src/clients/partner-client";
import { createLogger } from "../../src/lib/logger";
import { DeliveryService } from "../../src/services/delivery-service";
import type { DeliveryJob } from "../../src/services/delivery-service";
import {
  FakeAuditStore,
  FakeDeliveryRepository,
  FakePartnerClient,
  FakeStatusNotifier,
  NOW,
  aRequest,
} from "../helpers/fakes";
import type { Journal } from "../helpers/fakes";
import { captureLogs } from "../helpers/logs";

const MAX_RECEIVE_COUNT = 5;
const idNumber = (n: number): string => `01J8Z3K5W0ABCDEFGHJKMN${String(n).padStart(4, "0")}`;

const job = (n: number, receiveCount = 1): DeliveryJob => ({
  messageId: `msg-${n}`,
  body: JSON.stringify({ requestId: idNumber(n), ownerId: "user-a" }),
  receiveCount,
});

const DELIVERED: PartnerResult = { kind: "delivered", statusCode: 200 };
const REJECTED: PartnerResult = { kind: "rejected", statusCode: 422 };
const UNAVAILABLE: PartnerResult = { kind: "retryable", reason: "http_503", statusCode: 503 };

// `count` requests (numbered 1..count), all in status "queued", ready to be delivered.
function setup(count = 1) {
  const journal: Journal = [];
  const repository = new FakeDeliveryRepository(journal);
  const partner = new FakePartnerClient(journal);
  const audit = new FakeAuditStore(journal);
  const notifier = new FakeStatusNotifier(journal);
  for (let n = 1; n <= count; n++) repository.seed(aRequest({ id: idNumber(n) }));

  const logs = captureLogs();
  const service = new DeliveryService(repository, partner, audit, notifier, MAX_RECEIVE_COUNT, () => NOW);
  const deliver = (...jobs: DeliveryJob[]) => service.deliver(jobs, createLogger("debug"));
  return { journal, repository, partner, audit, notifier, logs, deliver };
}

describe("DeliveryService: delivered (2xx)", () => {
  it("sends, stores the audit copy, sets sent and publishes, in this order, then acknowledges", async () => {
    const { journal, repository, deliver } = setup();

    const result = await deliver(job(1));

    expect(journal).toEqual([
      "repo.find",
      "partner.send",
      "audit.save",
      "repo.markSent",
      "sns.publish:sent",
    ]);
    expect(repository.statusOf(idNumber(1))).toBe("sent");
    expect(result.failedMessageIds).toEqual([]);
    expect(result.counts.sent).toBe(1);
  });

  it("sends the five fields of the contract to the partner, without the status", async () => {
    const { partner, deliver } = setup();

    await deliver(job(1));

    expect(partner.sent).toEqual([
      {
        id: idNumber(1),
        partner: "Acme",
        subject: "Order 42",
        body: "Please ship.",
        createdAt: "2026-09-21T09:00:00.000Z",
      },
    ]);
  });

  it("stores the audit copy { sentAt, payload, partnerStatus }", async () => {
    const { audit, deliver } = setup();

    await deliver(job(1));

    expect(audit.saved).toEqual([
      {
        requestId: idNumber(1),
        copy: {
          sentAt: "2026-09-21T10:00:00.000Z",
          payload: {
            id: idNumber(1),
            partner: "Acme",
            subject: "Order 42",
            body: "Please ship.",
            createdAt: "2026-09-21T09:00:00.000Z",
          },
          partnerStatus: 200,
        },
      },
    ]);
  });

  it("publishes { requestId, status, at } for the sent status", async () => {
    const { notifier, deliver } = setup();

    await deliver(job(1));

    expect(notifier.published).toEqual([
      { requestId: idNumber(1), status: "sent", at: "2026-09-21T10:00:00.000Z" },
    ]);
  });

  it("also delivers a request that is still `created` (the worker was faster than the enqueuer)", async () => {
    const { repository, deliver } = setup();
    repository.setStatus(idNumber(1), "created");

    const result = await deliver(job(1));

    expect(repository.statusOf(idNumber(1))).toBe("sent");
    expect(result.failedMessageIds).toEqual([]);
  });

  it("records the status the partner really answered with (for example 202)", async () => {
    const { partner, audit, deliver } = setup();
    partner.answer = () => ({ kind: "delivered", statusCode: 202 });

    await deliver(job(1));

    expect(audit.saved[0]?.copy.partnerStatus).toBe(202);
  });
});

describe("DeliveryService: a finished request", () => {
  it.each(["sent", "rejected", "failed"] as const)(
    "acknowledges a %s request without calling the partner or changing anything",
    async (status) => {
      const { journal, repository, partner, audit, notifier, deliver } = setup();
      repository.setStatus(idNumber(1), status);

      const result = await deliver(job(1));

      expect(journal).toEqual(["repo.find"]);
      expect(partner.sent).toEqual([]);
      expect(audit.saved).toEqual([]);
      expect(notifier.published).toEqual([]);
      expect(repository.statusOf(idNumber(1))).toBe(status);
      expect(result.failedMessageIds).toEqual([]);
      expect(result.counts.alreadyDone).toBe(1);
    },
  );

  it("delivers a message that arrives twice only once", async () => {
    const { partner, deliver } = setup();

    await deliver(job(1));
    const second = await deliver(job(1)); // the duplicate

    expect(partner.sent).toHaveLength(1);
    expect(second.failedMessageIds).toEqual([]);
  });
});

describe("DeliveryService: the partner refuses (4xx)", () => {
  it("sets rejected, publishes, acknowledges and does not retry", async () => {
    const { journal, repository, partner, audit, deliver } = setup();
    partner.answer = () => REJECTED;

    const result = await deliver(job(1));

    expect(journal).toEqual(["repo.find", "partner.send", "repo.markRejected", "sns.publish:rejected"]);
    expect(repository.statusOf(idNumber(1))).toBe("rejected");
    expect(audit.saved).toEqual([]); // the audit copy is for delivered requests only
    expect(result.failedMessageIds).toEqual([]);
    expect(result.counts.rejected).toBe(1);
  });

  it("does not retry even on the first attempt of a message that could still be retried", async () => {
    const { partner, deliver } = setup();
    partner.answer = () => REJECTED;

    await deliver(job(1, 1));

    expect(partner.sent).toHaveLength(1);
  });
});

describe("DeliveryService: the partner cannot take it now (retryable)", () => {
  const retryables: [string, PartnerResult][] = [
    ["503", UNAVAILABLE],
    ["429", { kind: "retryable", reason: "http_429", statusCode: 429 }],
    ["408", { kind: "retryable", reason: "http_408", statusCode: 408 }],
    ["a timeout", { kind: "retryable", reason: "timeout" }],
    ["a network error", { kind: "retryable", reason: "network_error" }],
  ];

  it.each(retryables)("reports the message as failed after %s, and changes nothing", async (_label, answer) => {
    const { journal, repository, notifier, audit, partner, deliver } = setup();
    partner.answer = () => answer;

    const result = await deliver(job(1, 1));

    expect(result.failedMessageIds).toEqual(["msg-1"]);
    expect(result.counts.retry).toBe(1);
    expect(repository.statusOf(idNumber(1))).toBe("queued");
    expect(audit.saved).toEqual([]);
    expect(notifier.published).toEqual([]);
    expect(journal).toEqual(["repo.find", "partner.send"]);
  });

  it("still only retries on the attempt before the last one", async () => {
    const { repository, partner, deliver } = setup();
    partner.answer = () => UNAVAILABLE;

    const result = await deliver(job(1, MAX_RECEIVE_COUNT - 1));

    expect(result.failedMessageIds).toEqual(["msg-1"]);
    expect(repository.statusOf(idNumber(1))).toBe("queued");
  });
});

describe("DeliveryService: the last attempt", () => {
  it("writes failed and publishes first, and STILL reports the message so SQS moves it to the DLQ", async () => {
    const { journal, repository, notifier, partner, deliver } = setup();
    partner.answer = () => UNAVAILABLE;

    const result = await deliver(job(1, MAX_RECEIVE_COUNT));

    expect(journal).toEqual(["repo.find", "partner.send", "repo.markFailed", "sns.publish:failed"]);
    expect(repository.statusOf(idNumber(1))).toBe("failed");
    expect(notifier.published).toEqual([
      { requestId: idNumber(1), status: "failed", at: "2026-09-21T10:00:00.000Z" },
    ]);
    expect(result.failedMessageIds).toEqual(["msg-1"]);
    expect(result.counts.failed).toBe(1);
  });

  it("also treats a receive count above the maximum as the last attempt", async () => {
    const { repository, partner, deliver } = setup();
    partner.answer = () => UNAVAILABLE;

    const result = await deliver(job(1, MAX_RECEIVE_COUNT + 1));

    expect(repository.statusOf(idNumber(1))).toBe("failed");
    expect(result.failedMessageIds).toEqual(["msg-1"]);
  });

  it("does not write failed when the last attempt succeeds", async () => {
    const { repository, deliver } = setup();

    const result = await deliver(job(1, MAX_RECEIVE_COUNT));

    expect(repository.statusOf(idNumber(1))).toBe("sent");
    expect(result.failedMessageIds).toEqual([]);
  });

  it("acknowledges a refusal on the last attempt (rejected is final, the DLQ has nothing to keep)", async () => {
    const { repository, partner, deliver } = setup();
    partner.answer = () => REJECTED;

    const result = await deliver(job(1, MAX_RECEIVE_COUNT));

    expect(repository.statusOf(idNumber(1))).toBe("rejected");
    expect(result.failedMessageIds).toEqual([]);
  });

  it("acknowledges the message when somebody else finished the request in the meantime", async () => {
    const { repository, notifier, partner, deliver } = setup();
    partner.answer = () => UNAVAILABLE;
    repository.afterFind = () => repository.setStatus(idNumber(1), "sent");

    const result = await deliver(job(1, MAX_RECEIVE_COUNT));

    expect(repository.statusOf(idNumber(1))).toBe("sent");
    expect(notifier.published).toEqual([]);
    expect(result.failedMessageIds).toEqual([]);
    expect(result.counts.alreadyDone).toBe(1);
  });

  it("still reports the message when the notification fails", async () => {
    const { repository, notifier, partner, deliver } = setup();
    partner.answer = () => UNAVAILABLE;
    notifier.failWith = new Error("SNS down");

    const result = await deliver(job(1, MAX_RECEIVE_COUNT));

    expect(repository.statusOf(idNumber(1))).toBe("failed");
    expect(result.failedMessageIds).toEqual(["msg-1"]);
  });

  it("still reports the message when writing failed itself throws", async () => {
    const { repository, notifier, partner, deliver } = setup();
    partner.answer = () => UNAVAILABLE;
    repository.failures.set("markFailed", new Error("throttled"));

    const result = await deliver(job(1, MAX_RECEIVE_COUNT));

    expect(result.failedMessageIds).toEqual(["msg-1"]);
    expect(notifier.published).toEqual([]); // no status was written, so nothing to announce
  });
});

describe("DeliveryService: a batch of several messages", () => {
  it("stops at the first failure and reports it and every message after it", async () => {
    const { journal, repository, partner, deliver } = setup(4);
    partner.answer = (payload) => (payload.id === idNumber(2) ? UNAVAILABLE : DELIVERED);

    const result = await deliver(job(1), job(2), job(3), job(4));

    expect(result.failedMessageIds).toEqual(["msg-2", "msg-3", "msg-4"]);
    expect(partner.sent.map((payload) => payload.id)).toEqual([idNumber(1), idNumber(2)]);
    expect(repository.statusOf(idNumber(1))).toBe("sent");
    expect(repository.statusOf(idNumber(3))).toBe("queued"); // never touched
    expect(repository.statusOf(idNumber(4))).toBe("queued");
    expect(journal.filter((entry) => entry === "repo.find")).toHaveLength(2);
    expect(result.counts).toMatchObject({ sent: 1, retry: 1, notAttempted: 2 });
  });

  it("reports the whole batch when the first message fails", async () => {
    const { partner, deliver } = setup(3);
    partner.answer = () => UNAVAILABLE;

    const result = await deliver(job(1), job(2), job(3));

    expect(result.failedMessageIds).toEqual(["msg-1", "msg-2", "msg-3"]);
    expect(partner.sent).toHaveLength(1);
  });

  it("acknowledges everything when all messages succeed, in order", async () => {
    const { partner, deliver } = setup(3);

    const result = await deliver(job(1), job(2), job(3));

    expect(result.failedMessageIds).toEqual([]);
    expect(partner.sent.map((payload) => payload.id)).toEqual([idNumber(1), idNumber(2), idNumber(3)]);
  });

  it("does not stop for a refused or a finished request: those are acknowledged", async () => {
    const { repository, partner, deliver } = setup(3);
    repository.setStatus(idNumber(1), "sent");
    partner.answer = (payload) => (payload.id === idNumber(2) ? REJECTED : DELIVERED);

    const result = await deliver(job(1), job(2), job(3));

    expect(result.failedMessageIds).toEqual([]);
    expect(repository.statusOf(idNumber(3))).toBe("sent");
  });

  it("stops after a last-attempt failure too: that message and the rest are reported", async () => {
    const { repository, partner, deliver } = setup(2);
    partner.answer = () => UNAVAILABLE;

    const result = await deliver(job(1, MAX_RECEIVE_COUNT), job(2, 1));

    expect(repository.statusOf(idNumber(1))).toBe("failed");
    expect(repository.statusOf(idNumber(2))).toBe("queued");
    expect(result.failedMessageIds).toEqual(["msg-1", "msg-2"]);
  });
});

describe("DeliveryService: best-effort and idempotent steps", () => {
  it("does not fail the message when the SNS publish fails after a delivery", async () => {
    const { repository, notifier, logs, deliver } = setup();
    notifier.failWith = new Error("SNS down");

    const result = await deliver(job(1));

    expect(repository.statusOf(idNumber(1))).toBe("sent");
    expect(result.failedMessageIds).toEqual([]);
    expect(logs.entries().find((line) => line.message === "Status notification failed")).toMatchObject({
      level: "warn",
      errorMessage: "SNS down",
    });
  });

  it("does not fail the message when the SNS publish fails after a refusal", async () => {
    const { repository, partner, notifier, deliver } = setup();
    partner.answer = () => REJECTED;
    notifier.failWith = new Error("SNS down");

    const result = await deliver(job(1));

    expect(repository.statusOf(idNumber(1))).toBe("rejected");
    expect(result.failedMessageIds).toEqual([]);
  });

  it("treats a lost conditional update after a delivery as already handled: no publish, acknowledged", async () => {
    const { repository, notifier, deliver } = setup();
    repository.afterFind = () => repository.setStatus(idNumber(1), "failed"); // a parallel run finished it

    const result = await deliver(job(1));

    expect(repository.statusOf(idNumber(1))).toBe("failed");
    expect(notifier.published).toEqual([]);
    expect(result.failedMessageIds).toEqual([]);
    expect(result.counts.alreadyDone).toBe(1);
  });

  it("treats a lost conditional update after a refusal as already handled", async () => {
    const { repository, partner, notifier, deliver } = setup();
    partner.answer = () => REJECTED;
    repository.afterFind = () => repository.setStatus(idNumber(1), "sent");

    const result = await deliver(job(1));

    expect(notifier.published).toEqual([]);
    expect(result.failedMessageIds).toEqual([]);
  });

  it("makes the message retry when the S3 put fails: the partner is idempotent, the status stays queued", async () => {
    const { journal, repository, notifier, audit, deliver } = setup();
    audit.failWith = new Error("S3 down");

    const result = await deliver(job(1));

    expect(journal).toEqual(["repo.find", "partner.send", "audit.save"]);
    expect(repository.statusOf(idNumber(1))).toBe("queued");
    expect(notifier.published).toEqual([]);
    expect(result.failedMessageIds).toEqual(["msg-1"]);
    expect(result.counts.error).toBe(1);
  });

  it("sends the retry with the same Idempotency-Key (the request id) as the first attempt", async () => {
    const { audit, partner, deliver } = setup();
    audit.failWith = new Error("S3 down");

    await deliver(job(1, 1));
    audit.failWith = undefined;
    await deliver(job(1, 2));

    expect(partner.sent.map((payload) => payload.id)).toEqual([idNumber(1), idNumber(1)]);
  });
});

describe("DeliveryService: errors on our side", () => {
  it.each(["find", "markSent"])("reports the message when %s throws", async (operation) => {
    const { repository, deliver } = setup();
    repository.failures.set(operation, new Error("throttled"));

    const result = await deliver(job(1));

    expect(result.failedMessageIds).toEqual(["msg-1"]);
    expect(result.counts.error).toBe(1);
  });

  it("does not write failed on the last attempt for an error of our own (it is left to the DLQ alarm)", async () => {
    const { repository, notifier, audit, deliver } = setup();
    audit.failWith = new Error("S3 down");

    const result = await deliver(job(1, MAX_RECEIVE_COUNT));

    expect(repository.statusOf(idNumber(1))).toBe("queued");
    expect(notifier.published).toEqual([]);
    expect(result.failedMessageIds).toEqual(["msg-1"]);
  });

  it("logs error name, message and stack of a crash", async () => {
    const { repository, logs, deliver } = setup();
    repository.failures.set("find", new Error("throttled"));

    await deliver(job(1));

    const crash = logs.entries().find((line) => line.message === "Delivery attempt crashed");
    expect(crash).toMatchObject({
      level: "error",
      requestId: idNumber(1),
      errorName: "Error",
      errorMessage: "throttled",
    });
    expect(crash?.stack).toEqual(expect.stringContaining("throttled"));
  });

  it("reports a request that does not exist (goes to the DLQ in the end) and does not call the partner", async () => {
    const { partner, deliver } = setup(0);

    const result = await deliver(job(1));

    expect(result.failedMessageIds).toEqual(["msg-1"]);
    expect(result.counts.undeliverable).toBe(1);
    expect(partner.sent).toEqual([]);
  });

  it.each([
    ["not JSON", "{oops"],
    ["missing fields", '{"requestId":"x"}'],
  ])("reports a malformed message body (%s) without calling anything", async (_label, body) => {
    const { journal, logs, deliver } = setup();

    const result = await deliver({ messageId: "msg-9", body, receiveCount: 1 });

    expect(result.failedMessageIds).toEqual(["msg-9"]);
    expect(result.counts.undeliverable).toBe(1);
    expect(journal).toEqual([]);
    expect(logs.lines.join("\n")).not.toContain(body);
  });

  it("looks the request up under the owner named in the message", async () => {
    const { repository, deliver } = setup();
    repository.seed(aRequest({ id: idNumber(7) }), "user-b");

    const result = await deliver({
      messageId: "msg-7",
      body: JSON.stringify({ requestId: idNumber(7), ownerId: "user-a" }), // wrong owner
      receiveCount: 1,
    });

    expect(result.counts.undeliverable).toBe(1);
    expect(repository.statusOf(idNumber(7), "user-b")).toBe("queued");
  });
});

describe("DeliveryService: logging", () => {
  it("never logs the request text, whatever happens", async () => {
    const { repository, partner, audit, notifier, logs, deliver } = setup(4);
    partner.answer = (payload) => {
      if (payload.id === idNumber(2)) return REJECTED;
      if (payload.id === idNumber(3)) return UNAVAILABLE;
      return DELIVERED;
    };
    notifier.failWith = new Error("SNS down");
    audit.failWith = new Error("S3 down");
    repository.failures.set("markFailed", new Error("throttled"));

    await deliver(job(1), job(2), job(3, MAX_RECEIVE_COUNT), job(4));

    const everything = logs.lines.join("\n");
    expect(everything).not.toContain("Order 42");
    expect(everything).not.toContain("Please ship.");
  });
});
