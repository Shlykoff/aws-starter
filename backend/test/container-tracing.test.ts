import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SNSClient } from "@aws-sdk/client-sns";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { container as apiContainer } from "../src/container";
import { container as archiverContainer } from "../src/container-archiver";
import { container as enqueuerContainer } from "../src/container-enqueuer";
import { container as exchangeContainer } from "../src/container-exchange";
import { container as webhookContainer } from "../src/container-webhook";
import { container as workerContainer } from "../src/container-worker";
import type { ApiKeyProvider } from "../src/repositories/api-key-provider";
import type { DeliveryQueue } from "../src/repositories/delivery-queue";
import type { LogArchiveStore } from "../src/repositories/log-archive-store";
import { TOKENS } from "../src/tokens";
import { recordSpans } from "./helpers/tracing";

// Every port that talks to AWS or to the recipient is wrapped ONCE, in its container, so that each
// call becomes a span `<label>.<method>` (lib/tracing.ts, `tracedPort`). The AWS SDK's `send` is
// replaced, so nothing leaves the process; the containers read the variables of vitest.config.ts.
// (In Lambda the layer registers the SDK; here `recordSpans` does.)
vi.mock("../src/lib/schemas-location", () => ({
  SCHEMAS_DIRECTORY: new URL("../../contracts/xsd/", import.meta.url),
}));

const ddb = mockClient(DynamoDBDocumentClient);
const sqs = mockClient(SQSClient);
const sns = mockClient(SNSClient);
const s3 = mockClient(S3Client);
const ssm = mockClient(SSMClient);

beforeEach(() => {
  ddb.onAnyCommand().resolves({});
  sqs.onAnyCommand().resolves({ Failed: [] });
  sns.onAnyCommand().resolves({});
  s3.onAnyCommand().resolves({});
  ssm.onAnyCommand().resolves({ Parameter: { Value: "fake-secret-for-tests" } });
  // The partner client is built with the global fetch when the container first makes it.
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in tests")));
});
afterEach(() => {
  for (const mock of [ddb, sqs, sns, s3, ssm]) mock.reset();
  vi.unstubAllGlobals();
});
afterAll(() => {
  for (const mock of [ddb, sqs, sns, s3, ssm]) mock.restore();
});

const ID = "01J8Z3K5W0ABCDEFGHJKMNPQRS";
const decision = {
  decision: "Approved" as const,
  at: "2026-09-21T10:15:32.000Z",
  receivedAt: "2026-09-21T10:15:40.000Z",
  eventId: "3f0c6b1e-5a4d-4e7b-9c1a-2d6e8f0a1b3c",
};

type Port = Record<string, (...args: unknown[]) => unknown>;
interface Case {
  container: string;
  from: { get: (token: symbol) => unknown };
  token: symbol;
  method: string;
  args: unknown[];
  span: string;
}

const CASES: Case[] = [
  { container: "API functions", from: apiContainer, token: TOKENS.RequestRepository, method: "findById", args: ["user-a", ID], span: "requests.findById" },
  { container: "get-exchange", from: exchangeContainer, token: TOKENS.RequestRepository, method: "findById", args: ["user-a", ID], span: "requests.findById" },
  { container: "get-exchange", from: exchangeContainer, token: TOKENS.ExchangeStore, method: "find", args: [ID], span: "exchanges.find" },
  { container: "enqueuer", from: enqueuerContainer, token: TOKENS.DeliveryRepository, method: "markQueued", args: ["user-a", ID], span: "deliveries.markQueued" },
  { container: "enqueuer", from: enqueuerContainer, token: TOKENS.DeliveryQueue, method: "sendBatch", args: [[]], span: "queue.sendBatch" },
  { container: "receive-webhook", from: webhookContainer, token: TOKENS.DecisionRepository, method: "recordDecision", args: [ID, decision, 1], span: "decisions.recordDecision" },
  { container: "receive-webhook", from: webhookContainer, token: TOKENS.WebhookToken, method: "get", args: [], span: "webhook-token.get" },
  { container: "receive-webhook", from: webhookContainer, token: TOKENS.XmlValidator, method: "validateEvent", args: ["<not-an-event/>"], span: "xml-validator.validateEvent" },
  { container: "delivery-worker", from: workerContainer, token: TOKENS.DeliveryRepository, method: "findForDelivery", args: ["user-a", ID], span: "deliveries.findForDelivery" },
  { container: "delivery-worker", from: workerContainer, token: TOKENS.StatusNotifier, method: "publish", args: [{ requestId: ID, status: "sent", at: decision.at }], span: "notifier.publish" },
  { container: "delivery-worker", from: workerContainer, token: TOKENS.ExchangeStore, method: "find", args: [ID], span: "exchanges.find" },
  { container: "delivery-worker", from: workerContainer, token: TOKENS.ApiKeyProvider, method: "get", args: [], span: "api-key.get" },
  { container: "delivery-worker", from: workerContainer, token: TOKENS.XmlValidator, method: "validateSubmission", args: ["<not-a-submission/>"], span: "xml-validator.validateSubmission" },
  { container: "delivery-worker", from: workerContainer, token: TOKENS.PartnerClient, method: "send", args: [{ xml: "<x/>", idempotencyKey: ID, apiKey: "fake-key" }], span: "partner.send" },
];

describe("the ports of the containers are traced", () => {
  const spans = recordSpans();

  it.each(CASES)("$container: $span", async ({ from, token, method, args, span }) => {
    const port = from.get(token) as Port;

    // What the call answers does not matter here (the mocks answer with nothing); the span does.
    await Promise.resolve((port[method] as (...a: unknown[]) => unknown)(...args)).catch(() => undefined);

    expect(spans.all().map((recorded) => recorded.name)).toEqual([span]);
  });

  it("still does the work: the message goes to the queue through the wrapper", async () => {
    const queue = enqueuerContainer.get<DeliveryQueue>(TOKENS.DeliveryQueue);

    await queue.sendBatch([{ id: "seq-1", body: "{}", groupId: "g", deduplicationId: "d", traceHeader: "Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1" }]);

    const entry = sqs.commandCalls(SendMessageBatchCommand)[0]?.args[0].input.Entries?.[0];
    expect(entry?.MessageSystemAttributes?.AWSTraceHeader?.StringValue).toContain("Root=1-5759e988");
  });

  it("makes the span of a method that does not return a promise an instant one, and returns its value untouched", () => {
    const provider = workerContainer.get<ApiKeyProvider>(TOKENS.ApiKeyProvider);

    expect(provider.invalidate()).toBeUndefined();

    expect(spans.all().map((recorded) => recorded.name)).toEqual(["api-key.invalidate"]);
  });

  it("does not wrap the store of the log archive: writing logs is not a step of a request", async () => {
    const store = archiverContainer.get<LogArchiveStore>(TOKENS.LogArchiveStore);

    await store.put("logs/key.json.gz", new Uint8Array([1]));

    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(1);
    expect(spans.all()).toEqual([]);
  });
});
