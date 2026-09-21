import { describe, expect, it } from "vitest";
import type { PartnerSubmission } from "../../src/clients/partner-client";
import type { PartnerAnswer } from "../../src/domain/partner-answer";
import { createLogger } from "../../src/lib/logger";
import { DeliveryService } from "../../src/services/delivery-service";
import type { DeliveryJob } from "../../src/services/delivery-service";
import { createRealValidator } from "../helpers/contracts";
import {
  FakeApiKeyProvider,
  FakeDeliveryRepository,
  FakeExchangeStore,
  FakePartnerClient,
  FakeStatusNotifier,
  FakeXmlValidator,
  NOW,
  aRequest,
  acceptedAnswer,
  refusedAnswer,
  replyXml,
  unavailableAnswer,
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

const answer = (httpStatus: number, body?: string): PartnerAnswer => ({ kind: "answer", httpStatus, body });

// `count` requests (numbered 1..count), all in status "queued", ready to be delivered. The
// validator is a fake that says "valid" unless a test tells it otherwise; the tests that need
// the real messages of libxml2 use `setupWithRealValidator`.
function setup(count = 1, validator?: FakeXmlValidator | ReturnType<typeof createRealValidator>) {
  const journal: Journal = [];
  const repository = new FakeDeliveryRepository(journal);
  const partner = new FakePartnerClient(journal);
  const fakeValidator = new FakeXmlValidator(journal);
  const apiKeys = new FakeApiKeyProvider(journal);
  const exchanges = new FakeExchangeStore(journal);
  const notifier = new FakeStatusNotifier(journal);
  for (let n = 1; n <= count; n++) repository.seed(aRequest({ id: idNumber(n) }));

  const logs = captureLogs();
  const service = new DeliveryService(
    repository,
    partner,
    validator ?? fakeValidator,
    apiKeys,
    exchanges,
    notifier,
    { senderName: "aws-starter", maxReceiveCount: MAX_RECEIVE_COUNT },
    () => NOW,
  );
  const deliver = (...jobs: DeliveryJob[]) => service.deliver(jobs, createLogger("debug"));
  return { journal, repository, partner, validator: fakeValidator, apiKeys, exchanges, notifier, logs, deliver };
}

const lastExchange = (exchanges: FakeExchangeStore) => exchanges.saved.at(-1)?.exchange;

describe("DeliveryService: delivered (200 + Accepted)", () => {
  it("builds, checks, sends, checks the reply, records, sets sent and publishes, in this order", async () => {
    const { journal, repository, deliver } = setup();

    const result = await deliver(job(1));

    expect(journal).toEqual([
      "repo.find",
      "validator.submission",
      "apiKey.get",
      "partner.send",
      "validator.reply",
      "exchange.save",
      "repo.markSent",
      "sns.publish:sent",
    ]);
    expect(repository.statusOf(idNumber(1))).toBe("sent");
    expect(result.failedMessageIds).toEqual([]);
    expect(result.counts.sent).toBe(1);
  });

  it("sends the XML built from the request, with the request id as MessageId and as Idempotency-Key", async () => {
    const { partner, validator, deliver } = setup();

    await deliver(job(1));

    const sent = partner.sent[0] as PartnerSubmission;
    expect(sent.idempotencyKey).toBe(idNumber(1));
    expect(sent.apiKey).toBe("fake-api-key-for-tests");
    expect(sent.xml).toContain('<Submission xmlns="urn:aws-starter:submission:v1" version="1">');
    expect(sent.xml).toContain(`<MessageId>${idNumber(1)}</MessageId>`);
    expect(sent.xml).toContain("<SentAt>2026-09-21T10:00:00.000Z</SentAt>");
    expect(sent.xml).toContain("<Sender><Name>aws-starter</Name></Sender>");
    expect(sent.xml).toContain("<Recipient><Name>Acme</Name></Recipient>");
    expect(sent.xml).toContain("<Subject>Order 42</Subject>");
    expect(sent.xml).toContain("<Text>Please ship.</Text>");
    // The document that was checked against the schema is the document that was sent.
    expect(validator.submissions).toEqual([sent.xml]);
  });

  it("records the whole exchange: what was sent, what came back, and how it was read", async () => {
    const { partner, exchanges, deliver } = setup();

    await deliver(job(1, 3));

    const sent = partner.sent[0] as PartnerSubmission;
    expect(exchanges.saved).toEqual([
      {
        requestId: idNumber(1),
        exchange: {
          attempt: 3,
          at: "2026-09-21T10:00:00.000Z",
          outcome: "delivered",
          request: { xml: sent.xml, valid: true, problems: [] },
          reply: {
            httpStatus: 200,
            xml: replyXml({ relatesTo: idNumber(1) }),
            valid: true,
            status: "Accepted",
            code: undefined,
            description: undefined,
          },
        },
      },
    ]);
  });

  it("checks the reply body the recipient sent", async () => {
    const { validator, deliver } = setup();

    await deliver(job(1));

    expect(validator.replies).toEqual([replyXml({ relatesTo: idNumber(1) })]);
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

  it("uses the sender name from its settings", async () => {
    const journal: Journal = [];
    const repository = new FakeDeliveryRepository(journal);
    const partner = new FakePartnerClient(journal);
    repository.seed(aRequest({ id: idNumber(1) }));
    const service = new DeliveryService(
      repository,
      partner,
      new FakeXmlValidator(journal),
      new FakeApiKeyProvider(journal),
      new FakeExchangeStore(journal),
      new FakeStatusNotifier(journal),
      { senderName: "Sender & Sons", maxReceiveCount: MAX_RECEIVE_COUNT },
      () => NOW,
    );

    await service.deliver([job(1)], createLogger("error"));

    expect(partner.sent[0]?.xml).toContain("<Sender><Name>Sender &amp; Sons</Name></Sender>");
  });
});

describe("DeliveryService: a finished request", () => {
  it.each(["sent", "rejected", "failed"] as const)(
    "acknowledges a %s request without building, calling or changing anything",
    async (status) => {
      const { journal, repository, partner, exchanges, notifier, deliver } = setup();
      repository.setStatus(idNumber(1), status);

      const result = await deliver(job(1));

      expect(journal).toEqual(["repo.find"]);
      expect(partner.sent).toEqual([]);
      expect(exchanges.saved).toEqual([]);
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

describe("DeliveryService: the recipient refuses (400 or 422 + Rejected)", () => {
  it("records, sets rejected, publishes, acknowledges and does not retry", async () => {
    const { journal, repository, partner, exchanges, deliver } = setup();
    partner.answer = refusedAnswer;

    const result = await deliver(job(1));

    expect(journal).toEqual([
      "repo.find",
      "validator.submission",
      "apiKey.get",
      "partner.send",
      "validator.reply",
      "exchange.save",
      "repo.markRejected",
      "sns.publish:rejected",
    ]);
    expect(repository.statusOf(idNumber(1))).toBe("rejected");
    expect(lastExchange(exchanges)).toMatchObject({
      outcome: "refused",
      reply: { httpStatus: 422, valid: true, status: "Rejected", code: "RECIPIENT_REJECTED" },
    });
    expect(result.failedMessageIds).toEqual([]);
    expect(result.counts.rejected).toBe(1);
  });

  it("does not retry even on the first attempt of a message that could still be retried", async () => {
    const { partner, deliver } = setup();
    partner.answer = refusedAnswer;

    await deliver(job(1, 1));

    expect(partner.sent).toHaveLength(1);
  });

  it("refuses for good on any other 4xx too, even without a body", async () => {
    const { repository, partner, exchanges, deliver } = setup();
    partner.answer = () => answer(415);

    const result = await deliver(job(1));

    expect(repository.statusOf(idNumber(1))).toBe("rejected");
    expect(lastExchange(exchanges)).toMatchObject({ outcome: "refused", reply: { httpStatus: 415, xml: null, valid: false } });
    expect(result.failedMessageIds).toEqual([]);
  });
});

describe("DeliveryService: a request that must not be sent (nobody is called)", () => {
  it("text that XML cannot carry: recorded as unrepresentable, rejected", async () => {
    const { journal, repository, partner, apiKeys, exchanges, notifier, deliver } = setup();
    repository.seed(aRequest({ id: idNumber(1), subject: "bad\u0000subject" }));

    const result = await deliver(job(1));

    expect(journal).toEqual(["repo.find", "exchange.save", "repo.markRejected", "sns.publish:rejected"]);
    expect(partner.sent).toEqual([]);
    expect(apiKeys.invalidations).toBe(0);
    expect(lastExchange(exchanges)).toEqual({
      attempt: 1,
      at: "2026-09-21T10:00:00.000Z",
      outcome: "unrepresentable",
      request: { xml: "", valid: false, problems: [{ element: "Subject", rule: "character not allowed in XML" }] },
      reply: null,
    });
    expect(repository.statusOf(idNumber(1))).toBe("rejected");
    expect(notifier.published).toHaveLength(1);
    expect(result.failedMessageIds).toEqual([]);
    expect(result.counts.rejected).toBe(1);
  });

  it("names every element that has such a character, and never the character", async () => {
    const { repository, exchanges, deliver } = setup();
    repository.seed(aRequest({ id: idNumber(1), partner: "p\u0001", subject: "s\u0002", body: "b\uD800" }));

    await deliver(job(1));

    const problems = lastExchange(exchanges)?.request.problems;
    expect(problems?.map((problem) => problem.element)).toEqual(["Name", "Subject", "Text"]);
    expect(JSON.stringify(lastExchange(exchanges))).not.toMatch(/\\u000[12]|\\ud800/i);
  });

  it("XML that does not match submission.xsd: recorded as invalid_request with the problems, rejected", async () => {
    const { journal, repository, validator, partner, apiKeys, exchanges, deliver } = setup();
    const problems = [{ element: "Name", rule: "does not match the allowed pattern" }];
    validator.submissionResult = { valid: false, findings: problems };

    const result = await deliver(job(1));

    expect(journal).toEqual([
      "repo.find",
      "validator.submission",
      "exchange.save",
      "repo.markRejected",
      "sns.publish:rejected",
    ]);
    expect(partner.sent).toEqual([]);
    expect(apiKeys.invalidations).toBe(0);
    const record = lastExchange(exchanges);
    expect(record).toMatchObject({ outcome: "invalid_request", reply: null });
    expect(record?.request).toEqual({ xml: validator.submissions[0], valid: false, problems });
    expect(repository.statusOf(idNumber(1))).toBe("rejected");
    expect(result.failedMessageIds).toEqual([]);
  });

  it("does not call the key store: the key is not needed for a request that is not sent", async () => {
    const { journal, validator, deliver } = setup();
    validator.submissionResult = { valid: false, findings: [{ element: "Text", rule: "too long" }] };

    await deliver(job(1));

    expect(journal).not.toContain("apiKey.get");
  });
});

describe("DeliveryService: the real validator finds what the schema forbids", () => {
  const real = createRealValidator();

  it.each([
    ["text over 5000 characters", { body: "x".repeat(5001) }, [{ element: "Text", rule: "too long" }]],
    ["a subject over 200 characters", { subject: "s".repeat(201) }, [{ element: "Subject", rule: "too long" }]],
    ["a partner name with a character the schema does not allow", { partner: "Acme #1" }, [{ element: "Name", rule: "does not match the allowed pattern" }]],
    ["a partner name over 100 characters", { partner: "p".repeat(101) }, [{ element: "Name", rule: "too long" }]],
  ])("%s ends as invalid_request, and nobody is called", async (_label, overrides, problems) => {
    const { repository, partner, exchanges, deliver } = setup(1, real);
    repository.seed(aRequest({ id: idNumber(1), ...overrides }));

    const result = await deliver(job(1));

    expect(partner.sent).toEqual([]);
    expect(lastExchange(exchanges)).toMatchObject({ outcome: "invalid_request", request: { valid: false, problems } });
    expect(repository.statusOf(idNumber(1))).toBe("rejected");
    expect(result.failedMessageIds).toEqual([]);
  });

  it("delivers a request with characters that need escaping", async () => {
    const { repository, partner, deliver } = setup(1, real);
    repository.seed(aRequest({ id: idNumber(1), partner: "Smith & Sons, Inc.", subject: "Fish & chips <3", body: "a > b ]]> c\r\n😀" }));

    const result = await deliver(job(1));

    expect(partner.sent).toHaveLength(1);
    expect(result.counts.sent).toBe(1);
  });
});

describe("DeliveryService: the recipient cannot take it now (retry)", () => {
  const retryables: [string, PartnerAnswer][] = [
    ["503 without a body", unavailableAnswer],
    ["429", answer(429)],
    ["408", answer(408)],
    ["500", answer(500, "<html>error</html>")],
    ["a timeout", { kind: "no-answer", reason: "timeout" }],
    ["a network error", { kind: "no-answer", reason: "network_error" }],
    ["a redirect (never followed)", answer(302)],
    ["a 200 without a body", answer(200)],
    ["a 200 with a body that is too large", { kind: "answer", httpStatus: 200, body: undefined, bodyProblem: "too_large" }],
    ["a 200 with a body that is not a Reply", answer(200, "<html>a proxy error page</html>")],
  ];

  it.each(retryables)("reports the message as failed after %s, and changes nothing but the record", async (_label, given) => {
    const { journal, repository, notifier, exchanges, partner, validator, deliver } = setup();
    partner.answer = () => given;
    // A 200 that is "not a Reply": the validator refuses it. The others do not depend on this.
    validator.replyResult = { valid: false, findings: [{ element: "(document)", rule: "not well-formed XML" }] };

    const result = await deliver(job(1, 1));

    expect(result.failedMessageIds).toEqual(["msg-1"]);
    expect(result.counts.retry).toBe(1);
    expect(repository.statusOf(idNumber(1))).toBe("queued");
    expect(notifier.published).toEqual([]);
    expect(lastExchange(exchanges)).toMatchObject({ attempt: 1, outcome: "retry" });
    expect(journal.filter((entry) => entry.startsWith("repo.mark"))).toEqual([]);
  });

  it("records a reply that was received, even though it is not valid", async () => {
    const { exchanges, partner, validator, deliver } = setup();
    partner.answer = () => answer(200, "<html>oops</html>");
    validator.replyResult = { valid: false, findings: [{ element: "(document)", rule: "not well-formed XML" }] };

    await deliver(job(1));

    expect(lastExchange(exchanges)?.reply).toEqual({ httpStatus: 200, xml: "<html>oops</html>", valid: false });
  });

  it("records no reply at all when nobody answered", async () => {
    const { exchanges, partner, deliver } = setup();
    partner.answer = () => ({ kind: "no-answer", reason: "timeout" });

    await deliver(job(1));

    expect(lastExchange(exchanges)).toMatchObject({ outcome: "retry", reply: null });
  });

  it("does not check a reply that does not exist", async () => {
    const { validator, partner, deliver } = setup();
    partner.answer = () => unavailableAnswer;

    await deliver(job(1));

    expect(validator.replies).toEqual([]);
  });

  it("treats a valid Reply that contradicts the status code as a retry, not as a refusal or a delivery", async () => {
    const { repository, partner, exchanges, deliver } = setup();
    partner.answer = (submission) => answer(200, replyXml({ status: "Rejected", relatesTo: submission.idempotencyKey, code: "SCHEMA_INVALID", description: "x" }));

    const result = await deliver(job(1));

    expect(repository.statusOf(idNumber(1))).toBe("queued");
    expect(lastExchange(exchanges)).toMatchObject({ outcome: "retry", reply: { httpStatus: 200, valid: true, status: "Rejected" } });
    expect(result.failedMessageIds).toEqual(["msg-1"]);
  });

  it("treats a Reply about another submission as a retry", async () => {
    const { repository, partner, deliver } = setup();
    partner.answer = () => answer(200, replyXml({ relatesTo: "01J8Z3K5W0ABCDEFGHJKMNPQR9" }));

    const result = await deliver(job(1));

    expect(repository.statusOf(idNumber(1))).toBe("queued");
    expect(result.counts.retry).toBe(1);
  });

  it("treats an Accepted Reply that carries a Code as a retry (the rule XSD cannot express)", async () => {
    const { repository, partner, deliver } = setup();
    partner.answer = (submission) => answer(200, replyXml({ relatesTo: submission.idempotencyKey, code: "SCHEMA_INVALID" }));

    const result = await deliver(job(1));

    expect(repository.statusOf(idNumber(1))).toBe("queued");
    expect(result.counts.retry).toBe(1);
  });

  it("still only retries on the attempt before the last one", async () => {
    const { repository, partner, deliver } = setup();
    partner.answer = () => unavailableAnswer;

    const result = await deliver(job(1, MAX_RECEIVE_COUNT - 1));

    expect(result.failedMessageIds).toEqual(["msg-1"]);
    expect(repository.statusOf(idNumber(1))).toBe("queued");
  });
});

describe("DeliveryService: the exchange record of a retry is diagnostics only", () => {
  it("does not turn a failed write into an error: the retry goes on, and the failure is logged", async () => {
    const { repository, exchanges, partner, logs, deliver } = setup();
    partner.answer = () => unavailableAnswer;
    exchanges.failWith = new Error("S3 down");

    const result = await deliver(job(1));

    expect(result.counts).toMatchObject({ retry: 1, error: 0 });
    expect(result.failedMessageIds).toEqual(["msg-1"]);
    expect(repository.statusOf(idNumber(1))).toBe("queued");
    expect(logs.entries().find((line) => line.message === "The exchange record could not be written")).toMatchObject({
      level: "warn",
      errorMessage: "S3 down",
    });
  });

  it("still writes failed on the last attempt when the record cannot be written", async () => {
    const { repository, notifier, exchanges, partner, deliver } = setup();
    partner.answer = () => unavailableAnswer;
    exchanges.failWith = new Error("S3 down");

    const result = await deliver(job(1, MAX_RECEIVE_COUNT));

    expect(repository.statusOf(idNumber(1))).toBe("failed");
    expect(notifier.published).toHaveLength(1);
    expect(result.failedMessageIds).toEqual(["msg-1"]);
  });

  it("each attempt overwrites the record: it describes the latest attempt", async () => {
    const { exchanges, partner, deliver } = setup();
    partner.answer = () => unavailableAnswer;

    await deliver(job(1, 1));
    await deliver(job(1, 2));

    expect(exchanges.saved.map((saved) => [saved.requestId, saved.exchange.attempt])).toEqual([
      [idNumber(1), 1],
      [idNumber(1), 2],
    ]);
  });
});

describe("DeliveryService: the last attempt", () => {
  it("writes failed and publishes first, and STILL reports the message so SQS moves it to the DLQ", async () => {
    const { journal, repository, notifier, partner, deliver } = setup();
    partner.answer = () => unavailableAnswer;

    const result = await deliver(job(1, MAX_RECEIVE_COUNT));

    expect(journal).toEqual([
      "repo.find",
      "validator.submission",
      "apiKey.get",
      "partner.send",
      "exchange.save",
      "repo.markFailed",
      "sns.publish:failed",
    ]);
    expect(repository.statusOf(idNumber(1))).toBe("failed");
    expect(notifier.published).toEqual([
      { requestId: idNumber(1), status: "failed", at: "2026-09-21T10:00:00.000Z" },
    ]);
    expect(result.failedMessageIds).toEqual(["msg-1"]);
    expect(result.counts.failed).toBe(1);
  });

  it("keeps the record of the last attempt as a retry: it says what the recipient answered", async () => {
    const { exchanges, partner, deliver } = setup();
    partner.answer = () => unavailableAnswer;

    await deliver(job(1, MAX_RECEIVE_COUNT));

    expect(lastExchange(exchanges)).toMatchObject({ attempt: MAX_RECEIVE_COUNT, outcome: "retry", reply: { httpStatus: 503 } });
  });

  it("also treats a receive count above the maximum as the last attempt", async () => {
    const { repository, partner, deliver } = setup();
    partner.answer = () => unavailableAnswer;

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
    partner.answer = refusedAnswer;

    const result = await deliver(job(1, MAX_RECEIVE_COUNT));

    expect(repository.statusOf(idNumber(1))).toBe("rejected");
    expect(result.failedMessageIds).toEqual([]);
  });

  it("acknowledges the message when somebody else finished the request in the meantime", async () => {
    const { repository, notifier, partner, deliver } = setup();
    partner.answer = () => unavailableAnswer;
    repository.afterFind = () => repository.setStatus(idNumber(1), "sent");

    const result = await deliver(job(1, MAX_RECEIVE_COUNT));

    expect(repository.statusOf(idNumber(1))).toBe("sent");
    expect(notifier.published).toEqual([]);
    expect(result.failedMessageIds).toEqual([]);
    expect(result.counts.alreadyDone).toBe(1);
  });

  it("still reports the message when the notification fails", async () => {
    const { repository, notifier, partner, deliver } = setup();
    partner.answer = () => unavailableAnswer;
    notifier.failWith = new Error("SNS down");

    const result = await deliver(job(1, MAX_RECEIVE_COUNT));

    expect(repository.statusOf(idNumber(1))).toBe("failed");
    expect(result.failedMessageIds).toEqual(["msg-1"]);
  });

  it("still reports the message when writing failed itself throws", async () => {
    const { repository, notifier, partner, deliver } = setup();
    partner.answer = () => unavailableAnswer;
    repository.failures.set("markFailed", new Error("throttled"));

    const result = await deliver(job(1, MAX_RECEIVE_COUNT));

    expect(result.failedMessageIds).toEqual(["msg-1"]);
    expect(notifier.published).toEqual([]); // no status was written, so nothing to announce
  });
});

describe("DeliveryService: the API key", () => {
  it.each([401, 403])("forgets the key after a %i, so the next attempt reads it again; the message is retried", async (status) => {
    const { journal, apiKeys, repository, partner, deliver } = setup();
    partner.answer = () => answer(status);

    const result = await deliver(job(1));

    expect(apiKeys.invalidations).toBe(1);
    expect(journal.indexOf("apiKey.invalidate")).toBeGreaterThan(journal.indexOf("partner.send"));
    expect(repository.statusOf(idNumber(1))).toBe("queued");
    expect(result.failedMessageIds).toEqual(["msg-1"]);
  });

  it("on the last attempt a 401 ends as failed with an alarm, not as a silent rejected", async () => {
    const { repository, notifier, partner, deliver } = setup();
    partner.answer = () => answer(401);

    await deliver(job(1, MAX_RECEIVE_COUNT));

    expect(repository.statusOf(idNumber(1))).toBe("failed");
    expect(notifier.published[0]?.status).toBe("failed");
  });

  it.each([
    ["a 200", () => acceptedAnswer({ xml: "", idempotencyKey: idNumber(1), apiKey: "" })],
    ["a 422", () => answer(422)],
    ["a 503", () => unavailableAnswer],
    ["a timeout", (): PartnerAnswer => ({ kind: "no-answer", reason: "timeout" })],
  ])("keeps the key after %s", async (_label, given) => {
    const { apiKeys, partner, deliver } = setup();
    partner.answer = given;

    await deliver(job(1));

    expect(apiKeys.invalidations).toBe(0);
  });

  it("reports the message as an error of ours when the key cannot be read, without calling the recipient", async () => {
    const { repository, partner, exchanges, apiKeys, deliver } = setup();
    apiKeys.failWith = new Error("AccessDeniedException");

    const result = await deliver(job(1, MAX_RECEIVE_COUNT));

    expect(result.counts.error).toBe(1);
    expect(result.failedMessageIds).toEqual(["msg-1"]);
    expect(partner.sent).toEqual([]);
    expect(exchanges.saved).toEqual([]);
    expect(repository.statusOf(idNumber(1))).toBe("queued"); // an error of ours never writes failed
  });
});

describe("DeliveryService: a batch of several messages", () => {
  it("stops at the first failure and reports it and every message after it", async () => {
    const { journal, repository, partner, deliver } = setup(4);
    partner.answer = (submission) => (submission.idempotencyKey === idNumber(2) ? unavailableAnswer : acceptedAnswer(submission));

    const result = await deliver(job(1), job(2), job(3), job(4));

    expect(result.failedMessageIds).toEqual(["msg-2", "msg-3", "msg-4"]);
    expect(partner.sent.map((sent) => sent.idempotencyKey)).toEqual([idNumber(1), idNumber(2)]);
    expect(repository.statusOf(idNumber(1))).toBe("sent");
    expect(repository.statusOf(idNumber(3))).toBe("queued"); // never touched
    expect(repository.statusOf(idNumber(4))).toBe("queued");
    expect(journal.filter((entry) => entry === "repo.find")).toHaveLength(2);
    expect(result.counts).toMatchObject({ sent: 1, retry: 1, notAttempted: 2 });
  });

  it("reports the whole batch when the first message fails", async () => {
    const { partner, deliver } = setup(3);
    partner.answer = () => unavailableAnswer;

    const result = await deliver(job(1), job(2), job(3));

    expect(result.failedMessageIds).toEqual(["msg-1", "msg-2", "msg-3"]);
    expect(partner.sent).toHaveLength(1);
  });

  it("acknowledges everything when all messages succeed, in order", async () => {
    const { partner, deliver } = setup(3);

    const result = await deliver(job(1), job(2), job(3));

    expect(result.failedMessageIds).toEqual([]);
    expect(partner.sent.map((sent) => sent.idempotencyKey)).toEqual([idNumber(1), idNumber(2), idNumber(3)]);
  });

  it("does not stop for a refused, an invalid or a finished request: those are acknowledged", async () => {
    const { repository, validator, partner, deliver } = setup(4);
    repository.setStatus(idNumber(1), "sent");
    partner.answer = (submission) => (submission.idempotencyKey === idNumber(2) ? refusedAnswer(submission) : acceptedAnswer(submission));
    repository.seed(aRequest({ id: idNumber(3), subject: "bad\u0000" })); // unrepresentable
    validator.submissionResult = { valid: true };

    const result = await deliver(job(1), job(2), job(3), job(4));

    expect(result.failedMessageIds).toEqual([]);
    expect(repository.statusOf(idNumber(3))).toBe("rejected");
    expect(repository.statusOf(idNumber(4))).toBe("sent");
  });

  it("stops after a last-attempt failure too: that message and the rest are reported", async () => {
    const { repository, partner, deliver } = setup(2);
    partner.answer = () => unavailableAnswer;

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
    partner.answer = refusedAnswer;
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
    partner.answer = refusedAnswer;
    repository.afterFind = () => repository.setStatus(idNumber(1), "sent");

    const result = await deliver(job(1));

    expect(notifier.published).toEqual([]);
    expect(result.failedMessageIds).toEqual([]);
  });

  it.each([
    ["a delivery", () => undefined, ["repo.find", "validator.submission", "apiKey.get", "partner.send", "validator.reply", "exchange.save"]],
    ["a refusal", (context: ReturnType<typeof setup>) => { context.partner.answer = refusedAnswer; }, ["repo.find", "validator.submission", "apiKey.get", "partner.send", "validator.reply", "exchange.save"]],
    ["an invalid request", (context: ReturnType<typeof setup>) => { context.validator.submissionResult = { valid: false, findings: [{ element: "Text", rule: "too long" }] }; }, ["repo.find", "validator.submission", "exchange.save"]],
  ])("does not set the status when the record of %s cannot be written: the message retries", async (_label, arrange, expectedJournal) => {
    const context = setup();
    arrange(context);
    context.exchanges.failWith = new Error("S3 down");

    const result = await context.deliver(job(1));

    expect(context.journal).toEqual(expectedJournal);
    expect(context.repository.statusOf(idNumber(1))).toBe("queued");
    expect(context.notifier.published).toEqual([]);
    expect(result.failedMessageIds).toEqual(["msg-1"]);
    expect(result.counts.error).toBe(1);
  });

  it("sends the retry with the same MessageId as the first attempt (the recipient answers a known id with its stored answer)", async () => {
    const { exchanges, partner, deliver } = setup();
    exchanges.failWith = new Error("S3 down");

    await deliver(job(1, 1));
    exchanges.failWith = undefined;
    await deliver(job(1, 2));

    expect(partner.sent.map((sent) => sent.idempotencyKey)).toEqual([idNumber(1), idNumber(1)]);
    for (const sent of partner.sent) expect(sent.xml).toContain(`<MessageId>${idNumber(1)}</MessageId>`);
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

  it("reports the message when the validator cannot run, without calling the recipient", async () => {
    const { validator, partner, deliver } = setup();
    validator.validateSubmission = () => Promise.reject(new Error("XSD validation could not run"));

    const result = await deliver(job(1, MAX_RECEIVE_COUNT));

    expect(result.counts.error).toBe(1);
    expect(partner.sent).toEqual([]);
  });

  it("does not write failed on the last attempt for an error of our own (it is left to the DLQ alarm)", async () => {
    const { repository, notifier, exchanges, deliver } = setup();
    exchanges.failWith = new Error("S3 down");

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

  it("reports a request that does not exist (goes to the DLQ in the end) and does not call the recipient", async () => {
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

// The rule of this class: what a request contains never reaches a log line. Every branch of
// a delivery runs here with a CANARY in the subject, the text and the partner name, and the
// recipient's answers hold it too; then all captured log lines are searched for it. The
// validator is the REAL one, so the real messages of libxml2 (which quote values) are in play.
describe("DeliveryService: logging", () => {
  const CANARY = "CANARY9f3a7c";
  const canaryRequest = (n: number, overrides: Partial<Parameters<typeof aRequest>[0]> = {}) =>
    aRequest({
      id: idNumber(n),
      partner: `Partner ${CANARY}`,
      subject: `Subject ${CANARY}`,
      body: `Text ${CANARY} <b>&</b>`,
      ...overrides,
    });

  it("never logs the text of the request or of the reply, on any branch", async () => {
    const { repository, partner, exchanges, notifier, logs, deliver } = setup(0, createRealValidator());
    const scripted: Record<number, (submission: PartnerSubmission) => PartnerAnswer> = {
      1: acceptedAnswer, // delivered
      2: (submission) => // refused, and the recipient's description quotes the text
        answer(422, replyXml({ status: "Rejected", relatesTo: submission.idempotencyKey, code: "SCHEMA_INVALID", description: `The value '${CANARY}' is wrong` })),
      3: () => unavailableAnswer, // retry: 503
      4: () => answer(200, `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "${CANARY}">]><Reply>&e;</Reply>`), // a DOCTYPE in the reply
      5: () => answer(200, `not a reply at all ${CANARY}`), // not XML
      6: (submission) => answer(200, replyXml({ status: "Accepted", relatesTo: submission.idempotencyKey, code: "SCHEMA_INVALID", description: CANARY })), // breaks the Code rule
      7: () => ({ kind: "no-answer", reason: "timeout" }), // retry: nobody answered
      8: (submission) => acceptedAnswer(submission), // delivered, but the notification fails below
      9: () => unavailableAnswer, // the last attempt: failed
      10: () => answer(401), // the key is refused
    };
    partner.answer = (submission) => {
      const n = Number(submission.idempotencyKey.slice(-4));
      return (scripted[n] ?? acceptedAnswer)(submission);
    };
    for (let n = 1; n <= 10; n++) repository.seed(canaryRequest(n));
    repository.seed(canaryRequest(11, { partner: `Partner ${CANARY} #` })); // invalid: libxml2 quotes the name
    repository.seed(canaryRequest(12, { subject: `Subject ${CANARY}\u0000` })); // unrepresentable
    repository.seed(canaryRequest(13, { body: `x${CANARY}`.padEnd(5100, "y") })); // invalid: too long
    repository.seed(canaryRequest(14)); // the record cannot be written
    repository.seed(canaryRequest(15)); // the status cannot be written

    // One message at a time: a failure would stop a batch. A message that fails is delivered
    // again with the last attempt's receive count where the script says so.
    const receiveCounts: Record<number, number> = { 9: MAX_RECEIVE_COUNT };
    for (let n = 1; n <= 13; n++) {
      if (n === 8) notifier.failWith = new Error("SNS down");
      await deliver(job(n, receiveCounts[n] ?? 1));
      notifier.failWith = undefined;
    }
    exchanges.failWith = new Error("S3 down");
    await deliver(job(14));
    exchanges.failWith = undefined;
    repository.failures.set("markSent", new Error("throttled"));
    await deliver(job(15));

    const everything = logs.lines.join("\n");
    expect(logs.lines.length).toBeGreaterThan(20); // the branches did log something
    // (Words like "Subject" or "DOCTYPE" may appear: they are element and rule names.)
    for (const forbidden of [CANARY, "<Submission", "<Reply", "<?xml", "<b>", "The value", "is wrong"]) {
      expect(everything).not.toContain(forbidden);
    }
    // ... but the useful facts are there: ids, outcomes, status codes, rule names.
    expect(everything).toContain(idNumber(1));
    expect(everything).toContain('"httpStatus":422');
    expect(everything).toContain("Name: does not match the allowed pattern");
    expect(everything).toContain("Text: too long");
  });

  it("logs the status, the code and the recipient's message id of a reply, but not its description", async () => {
    const { repository, partner, logs, deliver } = setup(0, createRealValidator());
    repository.seed(canaryRequest(1));
    partner.answer = (submission) =>
      answer(422, replyXml({ status: "Rejected", relatesTo: submission.idempotencyKey, code: "RECIPIENT_REJECTED", description: `Because ${CANARY}` }));

    await deliver(job(1));

    const line = logs.entries().find((entry) => entry.message === "The partner answered");
    expect(line).toMatchObject({
      httpStatus: 422,
      decision: "refused",
      reason: "rejected",
      replyValid: true,
      replyStatus: "Rejected",
      replyCode: "RECIPIENT_REJECTED",
      replyMessageId: "3f2b8c1e-5a4d-4e7b-9c1a-2d6e8f0a1b3c",
    });
    expect(JSON.stringify(logs.entries())).not.toContain(CANARY);
  });

  it("logs which element and rule of the schema a reply broke, as names", async () => {
    const { repository, partner, logs, deliver } = setup(0, createRealValidator());
    repository.seed(canaryRequest(1));
    partner.answer = () => answer(200, `<Reply xmlns="urn:aws-starter:reply:v1" version="1"><MessageId>${CANARY}</MessageId></Reply>`);

    await deliver(job(1));

    const line = logs.entries().find((entry) => entry.message === "The partner answered");
    expect(line).toMatchObject({ decision: "retry", reason: "reply_invalid", replyValid: false });
    expect(line?.replyProblems).toEqual(expect.arrayContaining(["MessageId: does not match the allowed pattern"]));
    expect(JSON.stringify(logs.entries())).not.toContain(CANARY);
  });

  it("writes the same kind of line as before for a plain retry", async () => {
    const { partner, logs, deliver } = setup();
    partner.answer = () => unavailableAnswer;

    await deliver(job(1, 2));

    expect(logs.entries().find((entry) => entry.message === "Partner could not take the request")).toEqual({
      level: "warn",
      message: "Partner could not take the request",
      requestId: idNumber(1),
      reason: "http_503",
      receiveCount: 2,
      isLastAttempt: false,
    });
  });
});
