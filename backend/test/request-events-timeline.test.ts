import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { ulid } from "ulid";
import { afterAll, describe, expect, it } from "vitest";
import { createLogger } from "../src/lib/logger";
import { DynamoDecisionRepository } from "../src/repositories/dynamodb-decision-repository";
import { DynamoDeliveryRepository } from "../src/repositories/dynamodb-delivery-repository";
import { DynamoRequestRepository } from "../src/repositories/dynamodb-request-repository";
import { DeliveryService } from "../src/services/delivery-service";
import { EnqueueService } from "../src/services/enqueue-service";
import { RequestService } from "../src/services/request-service";
import { WebhookService } from "../src/services/webhook-service";
import {
  FakeApiKeyProvider,
  FakeDeliveryQueue,
  FakeExchangeStore,
  FakePartnerClient,
  FakeSenderIdentityProvider,
  FakeStatusNotifier,
  FakeXmlValidator,
  acceptedAnswer,
  unavailableAnswer,
} from "./helpers/fakes";
import type { Journal } from "./helpers/fakes";
import { stubTable } from "./helpers/fake-table";
import { captureLogs } from "./helpers/logs";
import { WEBHOOK_TOKEN, eventXml, sign } from "./helpers/webhook";

// The timeline of a request (docs/api.md, "Logs"): the real services and the real DynamoDB
// repositories, over an in-memory table, driven through whole lives of requests. The test reads
// what the functions wrote, the way the Logs Insights query of the docs does: the lines that have
// an `event` and the request's id, in the order they were written.

const OWNER = "CANARY-owner-7e1c";
const SENDER_EMAIL = "CANARY-sender-7e1c@example.test";
const ACCESS_TOKEN = "test-access-token";
const SUBJECT = "CANARY-subject-7e1c";
const BODY = "CANARY-body-7e1c";
const REASON = "CANARY-reason-7e1c"; // the Reason of the client's event
const CANARIES = [OWNER, SENDER_EMAIL, SUBJECT, BODY, REASON];
const MAX_RECEIVE_COUNT = 5;
const TABLE = "test-requests";

const ddb = mockClient(DynamoDBDocumentClient);
afterAll(() => ddb.restore());

// One clock for all the services, moved by the test (one minute per step).
let clock: Date;
const now = () => clock;
const wait = () => {
  clock = new Date(clock.getTime() + 60_000);
};

function build() {
  ddb.reset();
  stubTable(ddb);
  clock = new Date("2026-09-21T10:00:00.000Z");
  const logs = captureLogs();
  const log = createLogger("debug"); // strict: the tests run with LOG_STRICT=1
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  const journal: Journal = [];
  const queue = new FakeDeliveryQueue(journal);
  const partner = new FakePartnerClient(journal);
  const identity = new FakeSenderIdentityProvider();
  identity.email = SENDER_EMAIL;
  const requests = new RequestService(new DynamoRequestRepository(client, TABLE), identity, now, (() => {
    let n = 0;
    return () => ulid(1_000_000 + n++);
  })());
  const enqueuer = new EnqueueService(queue, new DynamoDeliveryRepository(client, TABLE));
  const worker = new DeliveryService(
    new DynamoDeliveryRepository(client, TABLE),
    partner,
    new FakeXmlValidator(journal),
    new FakeApiKeyProvider(journal),
    new FakeExchangeStore(journal),
    new FakeStatusNotifier(journal),
    { maxReceiveCount: MAX_RECEIVE_COUNT },
    now,
  );
  const webhook = new WebhookService(
    { get: () => Promise.resolve(WEBHOOK_TOKEN) },
    new FakeXmlValidator(journal),
    new DynamoDecisionRepository(client, TABLE),
    now,
  );

  // The enqueuer: the request goes onto the queue (`retryCount` is what the stream image says).
  const enqueue = async (requestId: string, retryCount = 0) => {
    await enqueuer.enqueue([{ key: `seq-${queue.calls.length}`, request: { requestId, ownerId: OWNER, retryCount } }], log);
  };
  // The worker: the message the enqueuer sent last, received `receiveCount` times.
  const deliver = async (receiveCount: number) => {
    const message = queue.calls.at(-1)?.[0];
    if (message === undefined) throw new Error("nothing was queued");
    await worker.deliver([{ messageId: message.id, body: message.body, receiveCount }], log);
  };
  // The recipient's event, signed as the contract says.
  const decide = async (requestId: string) => {
    const body = Buffer.from(eventXml({ relatesTo: requestId, decision: "Approved", reason: REASON }));
    const timestamp = String(Math.floor(clock.getTime() / 1000));
    return webhook.receive(
      { body, timestampHeader: timestamp, signatureHeader: sign(WEBHOOK_TOKEN, timestamp, body), contentType: "application/xml" },
      log,
    );
  };
  const create = () => requests.create(OWNER, { subject: SUBJECT, body: BODY }, ACCESS_TOKEN, log);

  // What the Logs Insights query of docs/api.md gives: the events of one request, in order.
  const timeline = (requestId: string) =>
    logs.entries().filter((entry) => entry.requestId === requestId && entry.event !== undefined);

  return { logs, log, partner, requests, enqueue, deliver, decide, create, timeline };
}

describe("the timeline of a request across the functions", () => {
  it("a request that is delivered: created, queued, attempted, sent", async () => {
    const { partner, create, enqueue, deliver, timeline } = build();

    const request = await create();
    wait();
    await enqueue(request.id);
    wait();
    await deliver(1);

    expect(timeline(request.id).map((entry) => entry.event)).toEqual([
      "request_created",
      "request_queued",
      "delivery_attempted",
      "request_sent",
    ]);
    expect(partner.sent[0]?.xml).toContain(SUBJECT); // the text really travelled: the canary check below is not vacuous
  });

  it("a request that fails, is sent again and is delivered, then gets a decision", async () => {
    const { requests, log, partner, create, enqueue, deliver, decide, timeline } = build();

    const request = await create();
    wait();
    await enqueue(request.id);
    wait();
    partner.answer = () => unavailableAnswer; // the recipient is down until the last attempt
    await deliver(MAX_RECEIVE_COUNT);
    wait();
    await requests.retry(OWNER, request.id, log); // the owner presses "Send again"
    wait();
    await enqueue(request.id, 1);
    wait();
    partner.answer = acceptedAnswer;
    await deliver(1);
    wait();
    expect(await decide(request.id)).toBe("applied");

    const events = timeline(request.id);
    expect(events.map((entry) => entry.event)).toEqual([
      "request_created",
      "request_queued",
      "delivery_attempted",
      "request_failed",
      "retry_requested",
      "request_queued",
      "delivery_attempted",
      "request_sent",
      "decision_recorded",
    ]);
    // The status changes chain: each `toStatus` is the `fromStatus` of the next change of status.
    expect(events.filter((entry) => entry.fromStatus !== undefined || entry.toStatus !== undefined).map((entry) => [entry.fromStatus, entry.toStatus])).toEqual([
      [undefined, "created"],
      ["created", "queued"],
      [undefined, "failed"],
      ["failed", "created"],
      ["created", "queued"],
      [undefined, "sent"],
    ]);
    expect(events.find((entry) => entry.event === "retry_requested")).toMatchObject({ retryCount: 1, role: "user" });
    // The minutes that the test let pass are in `sinceCreatedMs`.
    expect(events.filter((entry) => entry.event === "request_failed" || entry.event === "request_sent").map((entry) => entry.sinceCreatedMs)).toEqual([
      120_000, // failed: 2 minutes after the creation
      300_000, // sent: 5 minutes after
    ]);
    expect(events.at(-1)).toMatchObject({ event: "decision_recorded", role: "recipient", decision: "Approved" });
  });

  it("two requests do not mix: each id has its own timeline", async () => {
    const { create, enqueue, deliver, timeline } = build();

    const first = await create();
    const second = await create();
    await enqueue(first.id);
    await deliver(1);
    await enqueue(second.id);
    await deliver(1);

    expect(timeline(first.id)).toHaveLength(4);
    expect(timeline(second.id)).toHaveLength(4);
  });

  it("nothing in the logs of the whole flow holds the text of the request, the sender's e-mail, the reason or the owner", async () => {
    const { logs, requests, log, partner, create, enqueue, deliver, decide } = build();

    const request = await create();
    await enqueue(request.id);
    partner.answer = () => unavailableAnswer;
    await deliver(MAX_RECEIVE_COUNT);
    await requests.retry(OWNER, request.id, log);
    await enqueue(request.id, 1);
    partner.answer = acceptedAnswer;
    await deliver(1);
    await decide(request.id);

    expect(logs.lines.length).toBeGreaterThan(9); // the events and the technical lines
    for (const canary of CANARIES) expect(logs.lines.join("\n"), canary).not.toContain(canary);
  });
});
