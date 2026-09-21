import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiEvent } from "../../src/lib/http";
import type { ApiKeyProvider } from "../../src/repositories/api-key-provider";
import { TOKENS } from "../../src/tokens";
import { expected, fixture } from "../helpers/contracts";
import { createRequestEvent, getRequestEvent, lambdaContext, listRequestsEvent } from "../helpers/events";
import { stubTable } from "../helpers/fake-table";
import type { FakeTable } from "../helpers/fake-table";
import { captureLogs } from "../helpers/logs";
import {
  EVENT_ID,
  NOW_SECONDS,
  REQUEST_ID,
  WEBHOOK_TOKEN,
  answer,
  eventXml,
  sign,
  webhookEvent,
  withHeader,
} from "../helpers/webhook";

// The real handler, service, adapters, XSD validator (libxml2 as WebAssembly, the real schema
// files) and container. Replaced: the AWS SDK's `send` (DynamoDB by an in-memory table that
// EVALUATES the conditions it is given, SSM by a recorder). No network, no credentials. The
// schemas are read from contracts/xsd/ (in Lambda they are next to the bundle).
vi.mock("../../src/lib/schemas-location", () => ({
  SCHEMAS_DIRECTORY: new URL("../../../contracts/xsd/", import.meta.url),
}));

const ddb = mockClient(DynamoDBDocumentClient);
const ssm = mockClient(SSMClient);
let handler: typeof import("../../src/handlers/receive-webhook").handler;
let tokens: ApiKeyProvider;
let table: FakeTable;
let logs: ReturnType<typeof captureLogs>;
// The summary line of each call (the request event of an applied decision is another line).
const handledLines = () => logs.entries().filter((entry) => entry.message === "Webhook handled");

beforeAll(async () => {
  ({ handler } = await import("../../src/handlers/receive-webhook"));
  // The container's provider keeps the token for 5 minutes and lives as long as this file, so
  // every test starts with an empty cache and can count the reads of SSM. (The service only
  // sees the `get` half; the class behind it also has `invalidate`.)
  const { container } = await import("../../src/container-webhook");
  tokens = container.get<ApiKeyProvider>(TOKENS.WebhookToken);
});
beforeEach(() => {
  // Only the clock is fake: the WebAssembly validator needs real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_SECONDS * 1000);
  tokens.invalidate();
  ddb.reset();
  ssm.reset();
  table = stubTable(ddb);
  ssm.on(GetParameterCommand).resolves({ Parameter: { Value: WEBHOOK_TOKEN } });
  logs = captureLogs();
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  ddb.restore();
  ssm.restore();
});

const NOW_ISO = new Date(NOW_SECONDS * 1000).toISOString();
const send = (event = webhookEvent({ body: eventXml() })) => handler(event, lambdaContext());
const ssmReads = () => ssm.commandCalls(GetParameterCommand).length;
const tableCalls = () => ddb.calls().length;

function seedRequest(overrides: Record<string, unknown> = {}, ownerId = "user-a") {
  table.seed({
    pk: `USER#${ownerId}`,
    sk: `REQ#${REQUEST_ID}`,
    id: REQUEST_ID,
    partner: "Acme",
    subject: "Order 42",
    body: "Please ship.",
    status: "sent",
    createdAt: "2026-09-21T09:00:00.000Z",
    ...overrides,
  });
}
const stored = (): Record<string, unknown> | undefined => table.items().find((item) => item.sk === `REQ#${REQUEST_ID}`);
const body = (xml: string) => webhookEvent({ body: xml });

describe("receive-webhook: an event that is applied", () => {
  it("answers 200 with no body and stores the decision on the request", async () => {
    seedRequest();

    const response = await send(webhookEvent({ body: eventXml({ decision: "Declined", reason: "Out of stock" }) }));

    expect(response).toEqual(answer(200)); // no body; only the CORS header
    expect(stored()).toMatchObject({
      id: REQUEST_ID,
      subject: "Order 42",
      clientDecision: {
        decision: "Declined",
        reason: "Out of stock",
        at: "2026-09-21T10:15:32.000Z",
        receivedAt: NOW_ISO,
        eventId: EVENT_ID,
      },
      decisionAtMs: Date.UTC(2026, 8, 21, 10, 15, 32),
    });
  });

  it("finds the request through the index by its id and updates it by its key", async () => {
    seedRequest();

    await send();

    expect(ddb.commandCalls(QueryCommand).map((call) => call.args[0].input.IndexName)).toEqual(["by-request-id"]);
    expect(ddb.commandCalls(UpdateCommand).map((call) => call.args[0].input.Key)).toEqual([
      { pk: "USER#user-a", sk: `REQ#${REQUEST_ID}` },
    ]);
  });

  it("stores no reason when the event has none", async () => {
    seedRequest();

    await send();

    expect(stored()?.clientDecision).not.toHaveProperty("reason");
  });

  // A REST API hands the header names over as the sender wrote them, so each of these is a
  // sender that could exist (Title-Case, an HTTP/2 library that writes lower case, shouting, a mix).
  it.each([
    ["Title-Case", ["X-Webhook-Timestamp", "X-Webhook-Signature", "Content-Type"]],
    ["lower case", ["x-webhook-timestamp", "x-webhook-signature", "content-type"]],
    ["upper case", ["X-WEBHOOK-TIMESTAMP", "X-WEBHOOK-SIGNATURE", "CONTENT-TYPE"]],
    ["mixed case", ["x-Webhook-TIMESTAMP", "X-webhook-Signature", "cOnTeNt-TyPe"]],
  ])("reads the headers in %s", async (_label, [timestampName, signatureName, contentTypeName]) => {
    seedRequest();
    const event = webhookEvent({ body: eventXml() });
    const renamed: ApiEvent = {
      ...event,
      headers: {
        [timestampName ?? ""]: event.headers["X-Webhook-Timestamp"],
        [signatureName ?? ""]: event.headers["X-Webhook-Signature"],
        [contentTypeName ?? ""]: event.headers["Content-Type"],
      },
    };

    expect(await send(renamed)).toEqual(answer(200));
    expect(stored()?.clientDecision).toBeDefined();
  });

  it("does not take a header of another name that only contains the right one", async () => {
    seedRequest();
    const event = webhookEvent({ body: eventXml(), signature: null, headers: { "Not-X-Webhook-Signature": "v1=" + "0".repeat(64) } });

    expect(await send(event)).toEqual(answer(401));
  });

  it("answers 401, not a crash, when `headers` is null", async () => {
    seedRequest();

    expect(await send(webhookEvent({ body: eventXml(), headers: null }))).toEqual(answer(401));

    expect(ssmReads()).toBe(0);
    expect(tableCalls()).toBe(0);
  });

  it.each(["created", "queued", "sent", "failed", "rejected"])(
    "is stored on a request whose delivery status is %s, and does not change the status",
    async (status) => {
      seedRequest({ status });

      expect(await send()).toEqual(answer(200));

      expect(stored()).toMatchObject({ status, clientDecision: { decision: "Approved" } });
    },
  );

  it("is stored for a request that has not been recorded as sent yet (the event came first)", async () => {
    seedRequest({ status: "queued" });

    await send();
    expect(stored()).toMatchObject({ status: "queued", clientDecision: { decision: "Approved" } });
  });

  it("finds the request whoever owns it", async () => {
    seedRequest({}, "user-b");

    expect(await send()).toEqual(answer(200));

    expect(table.items().find((item) => item.pk === "USER#user-b")?.clientDecision).toBeDefined();
  });
});

describe("receive-webhook: several events for one request", () => {
  const E1 = "11111111-5a4d-4e7b-9c1a-2d6e8f0a1b3c";
  const E2 = "22222222-5a4d-4e7b-9c1a-2d6e8f0a1b3c";
  const earlier = eventXml({ eventId: E1, occurredAt: "2026-09-21T10:00:00Z", decision: "Approved" });
  const later = eventXml({ eventId: E2, occurredAt: "2026-09-21T11:00:00Z", decision: "Declined", reason: "changed my mind" });
  const decisionOf = () => (stored()?.clientDecision as { eventId: string; decision: string } | undefined);

  it("the same event again changes nothing, and is answered 200", async () => {
    seedRequest();
    await send(body(earlier));
    const first = structuredClone(stored());
    vi.setSystemTime((NOW_SECONDS + 100) * 1000); // a later delivery attempt

    const second = await send(webhookEvent({ body: earlier, timestamp: String(NOW_SECONDS + 100) }));

    expect(second).toEqual(answer(200));
    expect(stored()).toEqual(first); // not even `receivedAt` moved
    expect(handledLines().map((entry) => entry.outcome)).toEqual(["applied", "duplicate"]);
  });

  it("a later event replaces the decision", async () => {
    seedRequest();
    await send(body(earlier));

    expect(await send(body(later))).toEqual(answer(200));

    expect(stored()).toMatchObject({
      clientDecision: { decision: "Declined", reason: "changed my mind", at: "2026-09-21T11:00:00.000Z", eventId: E2 },
      decisionAtMs: Date.UTC(2026, 8, 21, 11),
    });
  });

  it("an earlier event that arrives late changes nothing, and is answered 200", async () => {
    seedRequest();
    await send(body(later));

    expect(await send(body(earlier))).toEqual(answer(200));

    expect(decisionOf()).toMatchObject({ eventId: E2, decision: "Declined" });
    expect(handledLines().map((entry) => entry.outcome)).toEqual(["applied", "ignored"]);
  });

  it("the same event id with a LATER time still changes nothing (an event never replaces itself)", async () => {
    seedRequest();
    await send(body(earlier));
    const first = structuredClone(stored());

    // A sender that breaks the contract and re-times an event it already sent.
    const retimed = eventXml({ eventId: E1, occurredAt: "2026-09-21T12:00:00Z", decision: "Declined" });
    expect(await send(body(retimed))).toEqual(answer(200));

    expect(stored()).toEqual(first);
    expect(handledLines().map((entry) => entry.outcome)).toEqual(["applied", "duplicate"]);
  });

  it("another event at the very same moment changes nothing (the first one stays)", async () => {
    seedRequest();
    await send(body(earlier));

    expect(await send(body(eventXml({ eventId: E2, occurredAt: "2026-09-21T10:00:00Z", decision: "Declined" })))).toEqual(answer(200));

    expect(decisionOf()).toMatchObject({ eventId: E1, decision: "Approved" });
  });

  it.each([
    ["in order", [earlier, later]],
    ["the later one first", [later, earlier]],
  ])("the later OccurredAt wins whatever the order of arrival: %s", async (_label, order) => {
    seedRequest();

    for (const xml of order) await send(body(xml));

    expect(decisionOf()).toMatchObject({ eventId: E2, decision: "Declined" });
  });

  it("the later OccurredAt wins when both arrive at the same moment", async () => {
    seedRequest();

    const answers = await Promise.all([send(body(later)), send(body(earlier))]);

    expect(answers).toEqual([answer(200), answer(200)]);
    expect(decisionOf()).toMatchObject({ eventId: E2 });
  });

  it("compares moments, not text: 12:00+04:00 is earlier than 09:00Z although it sorts after it", async () => {
    seedRequest();
    const nine = eventXml({ eventId: E2, occurredAt: "2026-09-21T09:00:00Z" }); // 09:00Z
    const noonPlusFour = eventXml({ eventId: E1, occurredAt: "2026-09-21T12:00:00+04:00" }); // 08:00Z

    await send(body(noonPlusFour));
    await send(body(nine));
    expect(decisionOf()?.eventId).toBe(E2);

    await send(body(noonPlusFour)); // the older one again: ignored
    expect(decisionOf()?.eventId).toBe(E2);
  });

  it("stores the time of the event as UTC whatever offset it was written with", async () => {
    seedRequest();

    await send(body(eventXml({ occurredAt: "2026-10-21T14:15:32+04:00" })));

    expect(stored()?.clientDecision).toMatchObject({ at: "2026-10-21T10:15:32.000Z" });
  });
});

describe("receive-webhook: a request that does not exist", () => {
  it("is answered 404, and nothing is created", async () => {
    expect(await send()).toEqual(answer(404));

    expect(table.items()).toEqual([]);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("does not become an item when the index still lists a request that is gone", async () => {
    // The index is eventually consistent: it can answer with a key whose item does not exist.
    ddb.on(QueryCommand, { IndexName: "by-request-id" }).resolves({ Items: [{ pk: "USER#gone", sk: `REQ#${REQUEST_ID}` }] });

    expect(await send()).toEqual(answer(404));

    // The update DID run, and its guard (attribute_exists) is what stopped it from creating the item.
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(1);
    expect(table.items()).toEqual([]);
  });

  it("is not confused with another request", async () => {
    seedRequest({}, "user-a");
    const other = "01M30JDSMHY8CRX59V35WV731T";

    expect(await send(body(eventXml({ relatesTo: other })))).toEqual(answer(404));

    expect(stored()?.clientDecision).toBeUndefined();
  });
});

// The answers of contracts/webhook-api.md, and the ORDER in which the checks run: every row
// has a request that would fail SEVERAL checks, and the answer is the first one in the list.
describe("receive-webhook: the answers, in the order of the contract", () => {
  const bytes = (n: number) => Buffer.from(eventXml() + " ".repeat(n - Buffer.byteLength(eventXml())));

  it("413 for a body over 65 536 bytes, even when the signature and the media type are wrong too", async () => {
    const event = webhookEvent({ body: bytes(65_537), token: "wrong", contentType: "text/plain" });

    expect(await send(event)).toEqual(answer(413));
    expect(ssmReads()).toBe(0);
    expect(tableCalls()).toBe(0);
  });

  it("413 counts the DECODED bytes of a base64 body, not the characters of its text", async () => {
    seedRequest();
    // 65 537 decoded bytes.
    expect(await send(webhookEvent({ body: bytes(65_537), isBase64Encoded: true }))).toEqual(answer(413));
    // 60 000 decoded bytes are about 80 000 characters of base64: over the limit as text, under it as bytes.
    const event = webhookEvent({ body: bytes(60_000), isBase64Encoded: true });
    expect((event.body ?? "").length).toBeGreaterThan(65_536);
    expect(await send(event)).toEqual(answer(200));
  });

  it("accepts a body of exactly 65 536 bytes", async () => {
    seedRequest();

    expect(await send(webhookEvent({ body: bytes(65_536) }))).toEqual(answer(200));
  });

  it.each([
    ["no timestamp", webhookEvent({ body: eventXml(), timestamp: null })],
    ["a timestamp that is not digits", webhookEvent({ body: eventXml(), timestamp: "1e9" })],
    ["a timestamp 301 s old", webhookEvent({ body: eventXml(), timestamp: String(NOW_SECONDS - 301) })],
    ["a timestamp 301 s ahead", webhookEvent({ body: eventXml(), timestamp: String(NOW_SECONDS + 301) })],
    ["no signature", webhookEvent({ body: eventXml(), signature: null })],
    ["a signature in upper case", webhookEvent({ body: eventXml(), signature: sign(WEBHOOK_TOKEN, String(NOW_SECONDS), eventXml()).toUpperCase() })],
    ["a signature of another version", webhookEvent({ body: eventXml(), signature: sign(WEBHOOK_TOKEN, String(NOW_SECONDS), eventXml()).replace("v1=", "v2=") })],
  ])("401 for %s, without asking SSM for the token (and before the media type)", async (_label, event) => {
    seedRequest();

    expect(await send(withHeader(event, "Content-Type", "text/plain"))).toEqual(answer(401));

    expect(ssmReads()).toBe(0);
    expect(tableCalls()).toBe(0);
  });

  it.each([
    ["the wrong token", webhookEvent({ body: eventXml(), token: "another-token" })],
    ["a body that was changed after signing", { ...webhookEvent({ body: eventXml() }), body: eventXml({ decision: "Declined" }) }],
    ["a timestamp that was changed after signing", webhookEvent({ body: eventXml(), timestamp: String(NOW_SECONDS + 1), signature: sign(WEBHOOK_TOKEN, String(NOW_SECONDS), eventXml()) })],
  ])("401 for %s: the token is read, and nothing after it happens", async (_label, event) => {
    seedRequest();

    expect(await send(withHeader(event, "Content-Type", "text/plain"))).toEqual(answer(401));

    expect(ssmReads()).toBe(1);
    expect(tableCalls()).toBe(0);
    expect(stored()?.clientDecision).toBeUndefined();
  });

  it("401 for a request without a body, unless the signature covers the empty body", async () => {
    // Signed over a document, then the body is gone (a REST API sends `body: null`).
    const signedForSomethingElse: ApiEvent = { ...webhookEvent({ body: eventXml() }), body: null };

    expect(await send(signedForSomethingElse)).toEqual(answer(401));
    expect(await send(webhookEvent())).toEqual(answer(400)); // signed over nothing: it is the XML that is missing
  });

  it("does not forget the token when a signature is wrong, so junk cannot force a read of SSM per call", async () => {
    seedRequest();

    await send(webhookEvent({ body: eventXml(), token: "wrong-1" }));
    await send(webhookEvent({ body: eventXml(), token: "wrong-2" }));
    await send();

    expect(ssmReads()).toBe(1);
  });

  it.each(["text/xml", "application/json", "application/xml-dtd", "text/plain", "application/xmlx", "xml"])(
    "415 for the media type %s (the signature is right)",
    async (contentType) => {
      seedRequest();

      expect(await send(webhookEvent({ body: eventXml(), contentType }))).toEqual(answer(415));

      expect(tableCalls()).toBe(0);
    },
  );

  it("415 when there is no Content-Type header at all", async () => {
    expect(await send(webhookEvent({ body: eventXml(), contentType: null }))).toEqual(answer(415));
  });

  it("415 comes before 400: a wrong media type with a broken document", async () => {
    expect(await send(webhookEvent({ body: "not xml", contentType: "text/plain" }))).toEqual(answer(415));
  });

  it.each(["application/xml", "application/xml; charset=utf-8", "Application/XML;charset=UTF-8", "application/xml ; charset=\"utf-8\""])(
    "accepts the media type %s",
    async (contentType) => {
      seedRequest();

      expect(await send(webhookEvent({ body: eventXml(), contentType }))).toEqual(answer(200));
    },
  );

  it("400 comes before 422: a document that is not well-formed is not looked at as a schema violation", async () => {
    expect(await send(body("<DecisionEvent><Decision>Maybe</DecisionEvent>"))).toEqual(answer(400));
  });

  it("422 comes before 404: an invalid event for a request that does not exist", async () => {
    expect(await send(body(eventXml({ decision: "Maybe", relatesTo: "01M30JDSMHY8CRX59V35WV731T" })))).toEqual(answer(422));
    expect(tableCalls()).toBe(0);
  });

  it("400 for bytes that are not UTF-8", async () => {
    const invalid = Buffer.concat([Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><DecisionEvent xmlns="urn:aws-starter:event:v1" version="1">`), Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from("</DecisionEvent>")]);

    // Base64, because a plain string could not carry these bytes.
    expect(await send(webhookEvent({ body: invalid, isBase64Encoded: true }))).toEqual(answer(400));
  });

  it("200 for a document that starts with a BOM", async () => {
    seedRequest();

    expect(await send(webhookEvent({ body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(eventXml())]), isBase64Encoded: true }))).toEqual(answer(200));
    expect(stored()?.clientDecision).toBeDefined();
  });

  it("422 for an OccurredAt that the schema allows and JavaScript cannot read (a five-digit year)", async () => {
    seedRequest();

    expect(await send(body(eventXml({ occurredAt: "12026-09-21T10:15:32Z" })))).toEqual(answer(422));

    expect(stored()?.clientDecision).toBeUndefined();
  });
});

// Every sample of contracts/fixtures/expected.json ("event"), signed and sent through the real
// handler: valid = 200, SCHEMA_INVALID = 422, MALFORMED_XML = 400.
describe("receive-webhook: the fixtures of the contract", () => {
  const STATUS: Record<string, number> = { valid: 200, SCHEMA_INVALID: 422, MALFORMED_XML: 400 };

  it.each(Object.entries(expected.event))("%s -> %s", async (name, want) => {
    seedRequest();

    const response = await send(webhookEvent({ body: fixture("event", name) }));

    expect(response).toEqual(answer(STATUS[want] ?? 0));
    // Only a valid event reaches the request.
    expect(Boolean(stored()?.clientDecision)).toBe(want === "valid");
  });

  it("keeps the Cyrillic reason of the fixture intact", async () => {
    seedRequest();

    await send(webhookEvent({ body: fixture("event", "valid/cyrillic-reason.xml") }));

    expect(stored()?.clientDecision).toMatchObject({ reason: "Нет в наличии" });
  });

  it("keeps the markup characters of a reason as text", async () => {
    seedRequest();

    await send(webhookEvent({ body: fixture("event", "valid/offset-time-zone.xml") }));

    expect(stored()?.clientDecision).toMatchObject({ reason: "Paid by card & confirmed <today>", at: "2026-10-21T10:15:32.000Z" });
  });
});

describe("receive-webhook: isBase64Encoded", () => {
  it("decodes a base64 body before it checks the signature", async () => {
    seedRequest();

    expect(await send(webhookEvent({ body: eventXml({ reason: "Нет в наличии" }), isBase64Encoded: true }))).toEqual(answer(200));

    expect(stored()?.clientDecision).toMatchObject({ reason: "Нет в наличии" });
  });

  it("takes a body that is not base64 as UTF-8 text", async () => {
    seedRequest();

    expect(await send(webhookEvent({ body: eventXml({ reason: "Нет в наличии" }), isBase64Encoded: false }))).toEqual(answer(200));
  });

  it("honours the flag: base64 text that is NOT flagged is a different body, so the signature fails", async () => {
    const flagged = webhookEvent({ body: eventXml(), isBase64Encoded: true });

    expect(await send({ ...flagged, isBase64Encoded: false })).toEqual(answer(401));
  });

  it("does not try to decode a text body as base64", async () => {
    // The same bytes, sent as text with the flag set: base64 decoding would turn them into rubbish.
    const plain = webhookEvent({ body: eventXml() });

    expect(await send({ ...plain, isBase64Encoded: true })).toEqual(answer(401));
  });
});

describe("receive-webhook: the token", () => {
  it("is read once for many calls (it is cached for 5 minutes)", async () => {
    seedRequest();

    await send();
    await send();
    await send();

    expect(ssmReads()).toBe(1);
    expect(ssm.commandCalls(GetParameterCommand)[0]?.args[0].input).toEqual({ Name: "/test/webhook-token", WithDecryption: true });
  });
});

describe("receive-webhook: failures on our side", () => {
  it.each([
    ["SSM fails", () => ssm.on(GetParameterCommand).rejects(new Error("SSM throttled"))],
    ["the token parameter has no value", () => ssm.on(GetParameterCommand).resolves({ Parameter: { Name: "x" } })],
    ["the index query fails", () => ddb.on(QueryCommand).rejects(new Error("query throttled"))],
    ["the update fails", () => ddb.on(UpdateCommand).rejects(new Error("update throttled"))],
  ])("answers 500 with no body when %s, and logs the error", async (_label, arrange) => {
    seedRequest();
    arrange();

    const response = await send();

    expect(response).toEqual(answer(500));
    expect(logs.entries().at(-1)).toMatchObject({ level: "error", message: "Webhook failed", outcome: "error", errorName: "Error" });
    expect(stored()?.clientDecision).toBeUndefined();
  });

  it("does not remember a failed read of the token: the next call reads it again", async () => {
    seedRequest();
    ssm.on(GetParameterCommand).rejectsOnce(new Error("SSM throttled")).resolves({ Parameter: { Value: WEBHOOK_TOKEN } });

    expect(await send()).toEqual(answer(500));
    expect(await send()).toEqual(answer(200));

    expect(ssmReads()).toBe(2);
  });
});

// The request API after a decision was stored: the same routes as before, one more field.
describe("the request API shows the decision and hides everything internal", () => {
  const CLIENT_DECISION = { decision: "Declined", reason: "Out of stock", at: "2026-09-21T10:15:32.000Z", receivedAt: NOW_ISO };
  const request = { id: REQUEST_ID, partner: "Acme", subject: "Order 42", body: "Please ship.", status: "sent", createdAt: "2026-09-21T09:00:00.000Z" };

  async function getHandlers() {
    const { handler: get } = await import("../../src/handlers/get-request");
    const { handler: list } = await import("../../src/handlers/list-requests");
    const { handler: create } = await import("../../src/handlers/create-request");
    return { get, list, create };
  }
  const json = (response: { body?: string }): unknown => JSON.parse(response.body ?? "null");

  it("GET /requests/{id} and GET /requests return clientDecision, and none of its internals", async () => {
    seedRequest();
    await send(webhookEvent({ body: eventXml({ decision: "Declined", reason: "Out of stock" }) }));
    const { get, list } = await getHandlers();

    const one = await get(getRequestEvent({ sub: "user-a", id: REQUEST_ID }), lambdaContext());
    const all = await list(listRequestsEvent({ sub: "user-a" }), lambdaContext());

    expect(json(one)).toEqual({ ...request, clientDecision: CLIENT_DECISION });
    expect(json(all)).toEqual({ items: [{ ...request, clientDecision: CLIENT_DECISION }] });
    for (const response of [one, all]) {
      for (const secret of ["decisionAtMs", "eventId", EVENT_ID, "pk", "sk", "USER#", "user-a"]) {
        expect(response.body).not.toContain(secret);
      }
    }
  });

  it("returns no clientDecision until the client has acted", async () => {
    seedRequest();
    const { get, list, create } = await getHandlers();

    const one = await get(getRequestEvent({ sub: "user-a", id: REQUEST_ID }), lambdaContext());
    const all = await list(listRequestsEvent({ sub: "user-a" }), lambdaContext());
    const created = await create(createRequestEvent({ sub: "user-a", body: JSON.stringify({ partner: "Acme", subject: "s", body: "b" }) }), lambdaContext());

    expect(json(one)).toEqual(request);
    expect(json(all)).toEqual({ items: [request] });
    expect(json(created)).not.toHaveProperty("clientDecision");
  });

  it("shows a decision without a reason as one without a reason", async () => {
    seedRequest();
    await send();
    const { get } = await getHandlers();

    const one = await get(getRequestEvent({ sub: "user-a", id: REQUEST_ID }), lambdaContext());

    expect(json(one)).toEqual({ ...request, clientDecision: { decision: "Approved", at: "2026-09-21T10:15:32.000Z", receivedAt: NOW_ISO } });
  });

  it("does not show the decision of a request to another user", async () => {
    seedRequest();
    await send();
    const { get } = await getHandlers();

    const other = await get(getRequestEvent({ sub: "user-b", id: REQUEST_ID }), lambdaContext());

    expect(other.statusCode).toBe(404);
  });
});

// The rule of this function: text from the recipient and the secrets never reach a log line. A
// CANARY is put into the reason and into every other field, and every branch runs; then all
// captured lines are searched for it, for the signatures that were sent, and for the token.
describe("receive-webhook: logging", () => {
  const CANARY = "CANARY9f3a7c";
  const TOKEN = `token-${CANARY}-not-a-secret`;
  const validCanary = eventXml({ reason: `Reason ${CANARY} &lt;b&gt; &amp;` });

  it("never logs the body, the reason, a header, a signature or the token, on any branch", async () => {
    seedRequest();
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: TOKEN } });
    const signatures: string[] = [];
    // A signed event; `change` may break one thing after signing.
    const signed = (xml: string | Buffer, extra: Parameters<typeof webhookEvent>[0] = {}) => {
      const event = webhookEvent({ body: xml, token: TOKEN, ...extra });
      signatures.push(event.headers["X-Webhook-Signature"] ?? "");
      return event;
    };
    const events = [
      // 200: applied, then the same again (duplicate), then an older one (ignored)
      signed(validCanary),
      signed(validCanary),
      signed(eventXml({ eventId: "22222222-5a4d-4e7b-9c1a-2d6e8f0a1b3c", occurredAt: "2026-01-01T00:00:00Z", reason: `Old ${CANARY}` })),
      // 413
      signed(`${CANARY}`.repeat(10_000)),
      // 401: junk headers, a wrong signature, a stale timestamp
      withHeader(signed(validCanary), "X-Webhook-Timestamp", `${CANARY}-ts`),
      withHeader(signed(validCanary), "X-Webhook-Signature", `v1=${CANARY}`),
      signed(validCanary, { token: `other-${CANARY}` }),
      signed(validCanary, { timestamp: "1" }),
      signed(validCanary, { signature: null }),
      // 415
      signed(validCanary, { contentType: `text/${CANARY}` }),
      // 400: a DOCTYPE with the canary, not well-formed, not UTF-8
      signed(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "${CANARY}">]><DecisionEvent>&e;</DecisionEvent>`),
      signed(`<DecisionEvent>${CANARY}<a></DecisionEvent>`),
      signed(`${CANARY}`),
      signed(Buffer.concat([Buffer.from(`<a>${CANARY}`), Buffer.from([0xff, 0xfe]), Buffer.from("</a>")]), { isBase64Encoded: true }),
      // 422: the canary in every field, in an element nobody knows, in the root, in the version
      signed(eventXml({ eventId: CANARY })),
      signed(eventXml({ occurredAt: CANARY })),
      signed(eventXml({ relatesTo: CANARY })),
      signed(eventXml({ decision: CANARY })),
      signed(eventXml({ reason: "x".repeat(600) + CANARY })),
      signed(eventXml().replace("</DecisionEvent>", `<${CANARY}>${CANARY}</${CANARY}></DecisionEvent>`)),
      signed(eventXml().replaceAll("DecisionEvent", CANARY)),
      signed(eventXml().replace('version="1"', `version="${CANARY}"`)),
      signed(eventXml({ occurredAt: `12026-09-21T10:15:32Z`, reason: CANARY })),
      // 404
      signed(eventXml({ relatesTo: "01M30JDSMHY8CRX59V35WV731T", reason: `Unknown ${CANARY}` })),
    ];

    const statuses: number[] = [];
    for (const event of events) statuses.push((await send(event)).statusCode ?? 0);
    // 500: SSM fails, then the index query, then the update; the canary is in a valid event each time.
    tokens.invalidate(); // the token was cached by the calls above
    ssm.reset();
    ssm.on(GetParameterCommand).rejects(new Error("SSM throttled"));
    statuses.push((await send(signed(validCanary))).statusCode ?? 0);
    ssm.reset();
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: TOKEN } });
    ddb.reset();
    table = stubTable(ddb);
    seedRequest();
    ddb.on(QueryCommand).rejects(new Error("query throttled"));
    statuses.push((await send(signed(validCanary))).statusCode ?? 0);
    ddb.reset();
    table = stubTable(ddb);
    seedRequest();
    ddb.on(UpdateCommand).rejects(new Error("update throttled"));
    statuses.push((await send(signed(validCanary))).statusCode ?? 0);

    // Every branch of the contract really ran.
    expect(new Set(statuses)).toEqual(new Set([200, 413, 401, 415, 400, 422, 404, 500]));
    const everything = logs.lines.join("\n");
    expect(logs.lines.length).toBeGreaterThanOrEqual(statuses.length);
    for (const forbidden of [CANARY, TOKEN, "<b>", "&lt;b", "<?xml", "<DecisionEvent", "Reason ", "DOCTYPE x", ...signatures.filter((s) => s !== "")]) {
      expect(everything).not.toContain(forbidden);
    }
    // Every line is JSON: nothing else (a library's own message with a piece of the document) was printed.
    expect(() => logs.entries()).not.toThrow();
    // ... but the useful facts are there: outcomes, rule names, ids, and fixed words for a failed signature.
    expect(everything).toContain('"outcome":"applied"');
    expect(everything).toContain('"outcome":"duplicate"');
    expect(everything).toContain('"outcome":"ignored"');
    expect(everything).toContain('"signatureProblem":"signature_mismatch"');
    expect(everything).toContain('"signatureProblem":"bad_timestamp"');
    expect(everything).toContain("Decision: value not allowed");
    expect(everything).toContain(REQUEST_ID);
  });
});
