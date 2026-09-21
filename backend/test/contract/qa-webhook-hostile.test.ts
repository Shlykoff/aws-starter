import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyProvider } from "../../src/repositories/api-key-provider";
import { TOKENS } from "../../src/tokens";
import { lambdaContext } from "../helpers/events";
import { stubTable } from "../helpers/fake-table";
import type { FakeTable } from "../helpers/fake-table";
import { captureLogs } from "../helpers/logs";

// QA, hostile input for the webhook, written from contracts/webhook-api.md and docs/api.md.
// Only what test/handlers/receive-webhook.test.ts and test/domain/*.test.ts do not already show.
// The signing helper below is QA's own reading of the contract (HMAC-SHA256, key = the token's
// UTF-8 bytes, message = "<timestamp>.<body>"), not the engineers' helper.

vi.mock("../../src/lib/schemas-location", () => ({
  SCHEMAS_DIRECTORY: new URL("../../../contracts/xsd/", import.meta.url),
}));

const ddb = mockClient(DynamoDBDocumentClient);
const ssm = mockClient(SSMClient);
let handler: typeof import("../../src/handlers/receive-webhook").handler;
let tokens: ApiKeyProvider;
let table: FakeTable;
let logs: ReturnType<typeof captureLogs>;

const TOKEN = "qa-hostile-token-not-a-secret";
const NOW = 1_789_985_740; // 2026-09-21T10:15:40Z
const RID = "01M30JDSMHY8CRX59V35WV731S";
const E1 = "11111111-5a4d-4e7b-9c1a-2d6e8f0a1b3c";
const E2 = "22222222-5a4d-4e7b-9c1a-2d6e8f0a1b3c";

beforeAll(async () => {
  ({ handler } = await import("../../src/handlers/receive-webhook"));
  const { container } = await import("../../src/container-webhook");
  tokens = container.get<ApiKeyProvider>(TOKENS.WebhookToken);
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW * 1000);
  tokens.invalidate();
  ddb.reset();
  ssm.reset();
  table = stubTable(ddb);
  ssm.on(GetParameterCommand).resolves({ Parameter: { Value: TOKEN } });
  logs = captureLogs();
  seed();
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  ddb.restore();
  ssm.restore();
});

/** An empty table with one request, owned by `owner`. */
function reseed(owner: string) {
  ddb.reset();
  table = stubTable(ddb);
  seed(owner);
}
function seed(owner = "user-a") {
  table.seed({ pk: `USER#${owner}`, sk: `REQ#${RID}`, id: RID, status: "sent", subject: "Order 42", createdAt: "2026-09-21T09:00:00.000Z" });
}
const decision = () => table.items().find((i) => i.sk === `REQ#${RID}`)?.clientDecision as
  | { decision: string; reason?: string; at: string; eventId: string }
  | undefined;
const decisionAtMs = () => table.items().find((i) => i.sk === `REQ#${RID}`)?.decisionAtMs;

const xml = (o: { eventId?: string; at?: string; decision?: string; reason?: string; declaration?: string; extra?: string } = {}) =>
  `${o.declaration ?? '<?xml version="1.0" encoding="UTF-8"?>'}\n<DecisionEvent xmlns="urn:aws-starter:event:v1" version="1"${o.extra ?? ""}>\n` +
  `  <EventId>${o.eventId ?? E1}</EventId>\n  <OccurredAt>${o.at ?? "2026-09-21T10:15:32Z"}</OccurredAt>\n  <RelatesTo>${RID}</RelatesTo>\n` +
  `  <Decision>${o.decision ?? "Approved"}</Decision>${o.reason === undefined ? "" : `\n  <Reason>${o.reason}</Reason>`}\n</DecisionEvent>\n`;

const sign = (token: string, timestamp: string, body: Buffer) =>
  `v1=${createHmac("sha256", Buffer.from(token, "utf8")).update(Buffer.from(timestamp, "ascii")).update(".").update(body).digest("hex")}`;

interface Post {
  bytes?: Buffer;
  ts?: string;
  signature?: string; // replaces the computed one
  headers?: Record<string, string>; // replaces the whole header set
  contentType?: string;
  base64?: boolean;
  noHeaders?: boolean; // the event has no `headers` property at all
  bodyText?: string; // replaces the body field as it is (with `bytes` still used for the signature)
}
function post(p: Post = {}): Promise<{ statusCode: number; body?: string; headers?: unknown }> {
  const bytes = p.bytes ?? Buffer.from(xml(), "utf8");
  const ts = p.ts ?? String(NOW);
  const headers = p.headers ?? {
    "content-type": p.contentType ?? "application/xml",
    "x-webhook-timestamp": ts,
    "x-webhook-signature": p.signature ?? sign(TOKEN, ts, bytes),
  };
  const event = {
    version: "2.0",
    routeKey: "POST /webhooks/partner",
    rawPath: "/webhooks/partner",
    rawQueryString: "",
    ...(p.noHeaders ? {} : { headers }),
    requestContext: { http: { method: "POST", path: "/webhooks/partner", sourceIp: "192.0.2.1" }, requestId: "qa", stage: "$default", timeEpoch: 0 },
    body: p.bodyText ?? (p.base64 ? bytes.toString("base64") : bytes.toString("utf8")),
    isBase64Encoded: p.base64 ?? false,
  } as unknown as APIGatewayProxyEventV2;
  return handler(event, lambdaContext()) as Promise<{ statusCode: number }>;
}

/** A valid DecisionEvent of exactly `size` bytes: trailing white space after the root element. */
function padded(size: number): Buffer {
  const base = Buffer.from(xml(), "utf8");
  return Buffer.concat([base.subarray(0, base.length - 1), Buffer.alloc(size - base.length, 0x20), Buffer.from("\n")]);
}

describe("size: the limit is on the decoded bytes", () => {
  it("65 536 bytes carried as base64 (87 384 characters of text) is accepted", async () => {
    const bytes = padded(65_536);
    expect(bytes.length).toBe(65_536);
    expect(bytes.toString("base64").length).toBeGreaterThan(65_536);

    expect(await post({ bytes, base64: true })).toEqual({ statusCode: 200 });
    expect(decision()?.decision).toBe("Approved");
  });

  it("65 537 bytes carried as base64 is 413, and nothing is stored", async () => {
    expect(await post({ bytes: padded(65_537), base64: true })).toEqual({ statusCode: 413 });
    expect(decision()).toBeUndefined();
  });
});

describe("headers as API Gateway may deliver them", () => {
  const bytes = Buffer.from(xml(), "utf8");
  const good = sign(TOKEN, String(NOW), bytes);
  const base = { "content-type": "application/xml", "x-webhook-timestamp": String(NOW), "x-webhook-signature": good };

  it.each([
    ["the timestamp header sent twice (joined with a comma)", { ...base, "x-webhook-timestamp": `${NOW},${NOW}` }],
    ["the timestamp header sent twice (comma and space)", { ...base, "x-webhook-timestamp": `${NOW}, ${NOW}` }],
    ["the signature header sent twice, the same value", { ...base, "x-webhook-signature": `${good},${good}` }],
    ["the signature header sent twice, the good one first", { ...base, "x-webhook-signature": `${good}, v1=${"0".repeat(64)}` }],
    ["the signature header sent twice, the good one last", { ...base, "x-webhook-signature": `v1=${"0".repeat(64)}, ${good}` }],
  ])("401 for %s", async (_label, headers) => {
    expect(await post({ bytes, headers })).toEqual({ statusCode: 401 });
    expect(decision()).toBeUndefined();
  });

  it("names in Title-Case are read (the HTTP names are case-insensitive)", async () => {
    const headers = { "Content-Type": "application/xml", "X-Webhook-Timestamp": String(NOW), "X-Webhook-Signature": good };
    expect(await post({ bytes, headers })).toEqual({ statusCode: 200 });
  });

  it("401, not a crash, when the event has no headers at all", async () => {
    expect(await post({ bytes, noHeaders: true }).catch((e: unknown) => e)).toEqual({ statusCode: 401 });
  });
});

describe("Content-Type", () => {
  it("Application/XML; charset=ISO-8859-1 is application/xml: the parameter is ignored, the reason survives", async () => {
    const bytes = Buffer.from(xml({ reason: "Нет в наличии" }), "utf8");
    expect(await post({ bytes, contentType: "Application/XML; charset=ISO-8859-1" })).toEqual({ statusCode: 200 });
    expect(decision()?.reason).toBe("Нет в наличии");
  });

  it.each(["application/soap+xml", "application/atom+xml", "text/plain; x=application/xml", "multipart/form-data; boundary=application/xml", "application/xml, application/xml", "application/"])(
    "415 for %j",
    async (contentType) => {
      expect(await post({ contentType })).toEqual({ statusCode: 415 });
      expect(decision()).toBeUndefined();
    },
  );
});

describe("the bytes of the document", () => {
  const status = async (bytes: Buffer, extra: Post = {}) => (await post({ bytes, ...extra })).statusCode;

  it("400 for a UTF-8 body that declares encoding UTF-16 (the declaration and the bytes disagree)", async () => {
    expect(await status(Buffer.from(xml({ declaration: '<?xml version="1.0" encoding="UTF-16"?>' }), "utf8"))).toBe(400);
  });

  it("a real UTF-16 document with a BOM, signed as sent, never causes a 5xx (the contract is silent: report what it does)", async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml({ declaration: '<?xml version="1.0" encoding="UTF-16"?>' }), "utf16le")]);
    expect([200, 400, 422]).toContain(await status(utf16, { base64: true }));
  });

  it("a declaration of ISO-8859-1 over UTF-8 bytes is never a 5xx (the contract is silent: report what it does)", async () => {
    const code = await status(Buffer.from(xml({ declaration: '<?xml version="1.0" encoding="ISO-8859-1"?>', reason: "Нет" }), "utf8"));
    expect([200, 400, 422]).toContain(code);
  });

  it.each([
    ["a raw NUL byte", `<x>\u0000</x>`],
    ["a reference to U+0000", xml({ reason: "a&#0;b" })],
    ["a reference to a control character (U+0001)", xml({ reason: "a&#1;b" })],
    ["a plain DOCTYPE without any entity", xml().replace("<DecisionEvent", "<!DOCTYPE DecisionEvent>\n<DecisionEvent")],
    ["a DOCTYPE after a comment", xml().replace("<DecisionEvent", "<!-- c -->\n<!DOCTYPE DecisionEvent [ ]>\n<DecisionEvent")],
    ["a DOCTYPE with a parameter entity only", xml().replace("<DecisionEvent", '<!DOCTYPE DecisionEvent [ <!ENTITY % p "x"> ]>\n<DecisionEvent')],
  ])("400 for %s", async (_label, text) => {
    expect(await status(Buffer.from(text, "utf8"))).toBe(400);
  });

  it("nesting 8 000 levels deep is answered 400 or 422, quickly and without a 5xx", async () => {
    const bytes = Buffer.from("<a>".repeat(8_000) + "</a>".repeat(8_000), "utf8");
    expect(bytes.length).toBeLessThanOrEqual(65_536);
    expect([400, 422]).toContain(await status(bytes));
  });

  it.each([
    ["two Reason elements", xml({ reason: "one" }).replace("</DecisionEvent>", "<Reason>two</Reason></DecisionEvent>")],
    ["two EventId elements", xml().replace("</DecisionEvent>", `<EventId>${E2}</EventId></DecisionEvent>`)],
    ["501 characters made of astral code points (1 002 UTF-16 units, 2 004 bytes)", xml({ reason: "\u{1F44D}".repeat(501) })],
    ["an attribute of another namespace's element inside the root", xml({ extra: ' xmlns:x="urn:x" x:extra="1"' })],
  ])("422 for %s", async (_label, text) => {
    expect(await status(Buffer.from(text, "utf8"))).toBe(422);
  });

  it("an xsi:noNamespaceSchemaLocation pointing at another host is never fetched (and the event is still judged by our schema)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const text = xml({ extra: ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="https://attacker.invalid/evil.xsd"' });
    expect([200, 422]).toContain(await status(Buffer.from(text, "utf8")));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a prefix, a comment, CDATA and character references in one document are read as text", async () => {
    const text =
      `<?xml version="1.0"?><e:DecisionEvent xmlns:e="urn:aws-starter:event:v1" version="1"><e:EventId>${E1}</e:EventId>` +
      `<e:OccurredAt>2026-09-21T10:15:32Z</e:OccurredAt><!-- c --><e:RelatesTo>${RID}</e:RelatesTo><e:Decision>Declined</e:Decision>` +
      `<e:Reason><![CDATA[<b>1 & 2</b>]]> &amp; &#x41;&#66;</e:Reason></e:DecisionEvent>`;
    expect(await status(Buffer.from(text, "utf8"))).toBe(200);
    expect(decision()?.reason).toBe("<b>1 & 2</b> & AB");
  });

  it("a reason of white space only is 200 and is stored as it came, or dropped: never a 5xx (report which)", async () => {
    const code = await status(Buffer.from(xml({ reason: "   " }), "utf8"));
    expect([200, 422]).toContain(code);
  });
});

describe("isBase64Encoded with a body that is not base64", () => {
  it.each(["!!!not base64!!!", "%%%%", "====", "QUJD=RA", "\u0000\u0001"])("401 for %j (the decoded bytes cannot match the signature)", async (text) => {
    const response = await post({ bytes: Buffer.from(text, "utf8"), base64: true, bodyText: text });
    expect(response).toEqual({ statusCode: 401 });
    expect(decision()).toBeUndefined();
  });
});

describe("a request that belongs to another user", () => {
  it("is updated through the index; the answer and the logs say nothing about the owner", async () => {
    reseed("user-owner-4d2f"); // the owner of the request is somebody else

    const response = await post({ bytes: Buffer.from(xml({ reason: "hello" }), "utf8") });

    expect(response).toEqual({ statusCode: 200 }); // no body, no headers
    expect(table.items().find((i) => i.pk === "USER#user-owner-4d2f")?.clientDecision).toBeDefined();
    const everything = logs.lines.join("\n");
    expect(everything).not.toContain("user-owner-4d2f");
    expect(everything).not.toContain("USER#");
  });

  it("the index is queried by the request id only, never with an owner", async () => {
    await post();
    const query = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(JSON.stringify(query)).not.toContain("USER#");
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(1);
  });
});

describe("OccurredAt", () => {
  const send = (at: string, eventId: string, reason?: string) => post({ bytes: Buffer.from(xml({ at, eventId, reason }), "utf8") });

  it("the same instant written with +04:00 and with Z is the same moment: the first stays (either order)", async () => {
    expect(await send("2026-10-21T14:15:32+04:00", E1)).toEqual({ statusCode: 200 });
    expect(await send("2026-10-21T10:15:32Z", E2)).toEqual({ statusCode: 200 });
    expect(decision()?.eventId).toBe(E1);
    expect(decisionAtMs()).toBe(Date.UTC(2026, 9, 21, 10, 15, 32));

    reseed("user-a");
    await send("2026-10-21T10:15:32Z", E1);
    await send("2026-10-21T14:15:32+04:00", E2);
    expect(decision()?.eventId).toBe(E1);
  });

  it("a later instant with a negative offset replaces an earlier one that sorts after it as text", async () => {
    await send("2026-10-21T13:00:00Z", E1);
    await send("2026-10-21T09:30:00-05:00", E2); // 14:30Z: later, although "09:30" sorts before "13:00"
    expect(decision()?.eventId).toBe(E2);
    expect(decision()?.at).toBe("2026-10-21T14:30:00.000Z");
  });

  it("the extreme offsets +14:00 and -14:00 are read; +15:00 is refused by the schema (422)", async () => {
    expect(await send("2026-10-21T14:15:32+14:00", E1)).toEqual({ statusCode: 200 });
    expect(decisionAtMs()).toBe(Date.UTC(2026, 9, 21, 0, 15, 32));
    expect(await send("2026-10-21T14:15:32+15:00", E2)).toEqual({ statusCode: 422 });
  });

  it("CHARACTERISATION (the known open question): the year 9999 is stored, and then no real event can replace it", async () => {
    expect(await send("9999-12-31T23:59:59.999Z", E1)).toEqual({ statusCode: 200 });
    expect(decisionAtMs()).toBe(253_402_300_799_999);
    expect(await send("2026-09-21T10:15:39Z", E2, "real decision")).toEqual({ statusCode: 200 }); // acknowledged...
    expect(decision()?.eventId).toBe(E1); // ...and ignored
  });

  it("the year 0001 is read (a negative number of milliseconds), and any later event replaces it", async () => {
    expect(await send("0001-01-01T00:00:00Z", E1)).toEqual({ statusCode: 200 });
    expect(decisionAtMs()).toBe(-62_135_596_800_000);
    await send("2026-09-21T10:15:39Z", E2);
    expect(decision()?.eventId).toBe(E2);
  });

  it("DOCUMENTED: times are compared in milliseconds, so an event 0.4 ms later does not replace (docs/api.md says milliseconds)", async () => {
    await send("2026-09-21T10:15:32.1000Z", E1);
    await send("2026-09-21T10:15:32.1004Z", E2);
    expect(decision()?.eventId).toBe(E1);
  });

  it("a later event WITHOUT a reason replaces the whole decision: no reason of the old one is left behind", async () => {
    await send("2026-09-21T10:00:00Z", E1, "old reason");
    await send("2026-09-21T11:00:00Z", E2);
    expect(decision()?.eventId).toBe(E2);
    expect(decision()).not.toHaveProperty("reason");
  });
});

describe("the token", () => {
  it("is used exactly as SSM gives it: a trailing newline is part of the key (the contract: the token's UTF-8 bytes)", async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: `${TOKEN}\n` } });
    tokens.invalidate();
    const bytes = Buffer.from(xml(), "utf8");
    const ts = String(NOW);

    expect(await post({ bytes, signature: sign(TOKEN, ts, bytes) })).toEqual({ statusCode: 401 });
    expect(await post({ bytes, signature: sign(`${TOKEN}\n`, ts, bytes) })).toEqual({ statusCode: 200 });
  });
});
