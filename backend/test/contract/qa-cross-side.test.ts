import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyProvider } from "../../src/repositories/api-key-provider";
import { TOKENS } from "../../src/tokens";
import { lambdaContext } from "../helpers/events";
import { stubTable } from "../helpers/fake-table";
import type { FakeTable } from "../helpers/fake-table";
import { captureLogs } from "../helpers/logs";

// QA, cross-side: the requests in qa-cross-side-vectors.json were produced by the SENDER side
// (partner-sim: app/events.py builds the event, app/webhook.py signs it and sets the headers).
// This file feeds each one to the real Node receiver and checks the answer and what is stored
// against what the event says. The expectations come from the events, never from the receiver.

interface Vector {
  name: string;
  token: string;
  nowSeconds: number;
  headers: Record<string, string>;
  bodyBase64: string;
  expectStatus: number;
  expect: { requestId: string; decision: string; reason: string | null; atMs: number; eventId: string } | null;
}
const { vectors } = JSON.parse(readFileSync(new URL("./qa-cross-side-vectors.json", import.meta.url), "utf8")) as {
  vectors: Vector[];
};

vi.mock("../../src/lib/schemas-location", () => ({
  SCHEMAS_DIRECTORY: new URL("../../../contracts/xsd/", import.meta.url),
}));

const ddb = mockClient(DynamoDBDocumentClient);
const ssm = mockClient(SSMClient);
let handler: typeof import("../../src/handlers/receive-webhook").handler;
let tokens: ApiKeyProvider;
let table: FakeTable;

beforeAll(async () => {
  ({ handler } = await import("../../src/handlers/receive-webhook"));
  const { container } = await import("../../src/container-webhook");
  tokens = container.get<ApiKeyProvider>(TOKENS.WebhookToken);
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); // the WebAssembly validator needs real timers
  tokens.invalidate(); // a fresh token for every vector
  ddb.reset();
  ssm.reset();
  table = stubTable(ddb);
  captureLogs();
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  ddb.restore();
  ssm.restore();
});

const REQUEST_ID = "01M30JDSMHY8CRX59V35WV731S";

/** POST /webhooks/partner as API Gateway's HTTP API (payload 2.0) hands it to the function. */
function apiGatewayEvent(headers: Record<string, string>, bytes: Buffer, base64: boolean): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "POST /webhooks/partner",
    rawPath: "/webhooks/partner",
    rawQueryString: "",
    headers,
    requestContext: {
      accountId: "000000000000",
      apiId: "qa",
      domainName: "api.example.test",
      domainPrefix: "api",
      http: { method: "POST", path: "/webhooks/partner", protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "qa" },
      requestId: "qa-request",
      routeKey: "POST /webhooks/partner",
      stage: "$default",
      time: "21/Sep/2026:10:15:40 +0000",
      timeEpoch: 0,
    },
    body: base64 ? bytes.toString("base64") : bytes.toString("utf8"),
    isBase64Encoded: base64,
  };
}

/** Both ways API Gateway can carry the bytes; the text form only when it is lossless. */
function encodings(bytes: Buffer): { label: string; base64: boolean }[] {
  const lossless = Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
  return [...(lossless ? [{ label: "text body", base64: false }] : []), { label: "base64 body", base64: true }];
}

async function run(v: Vector, base64: boolean) {
  const bytes = Buffer.from(v.bodyBase64, "base64");
  vi.setSystemTime(v.nowSeconds * 1000);
  ssm.on(GetParameterCommand).resolves({ Parameter: { Value: v.token } });
  table.seed({
    pk: "USER#qa-owner",
    sk: `REQ#${REQUEST_ID}`,
    id: REQUEST_ID,
    partner: "Acme",
    subject: "Order 42",
    body: "Please ship.",
    status: "sent",
    createdAt: "2026-09-21T09:00:00.000Z",
  });
  return handler(apiGatewayEvent(v.headers, bytes, base64), lambdaContext());
}
const stored = () => table.items().find((item) => item.sk === `REQ#${REQUEST_ID}`);

// The receiver's XML reader once turned U+2028 and U+0085 inside a Reason into a line feed (an XML
// 1.1 rule; XML 1.0, which the contract uses, keeps them). Fixed in domain/xml-root.ts; the
// vector that carries them is skipped in the whole-vector loop below and has its own test.
const LINE_SEPARATORS = "built: u2028 u0085 feff";

const accepted = vectors.filter((v) => v.expectStatus === 200);
const refused = vectors.filter((v) => v.expectStatus === 401);

describe("cross-side: requests signed by partner-sim's own code", () => {
  it("the vector file holds what the checks below assume", () => {
    expect(accepted.length).toBeGreaterThanOrEqual(25);
    expect(refused.length).toBeGreaterThanOrEqual(12);
    expect(vectors.every((v) => v.headers["x-webhook-signature"]?.match(/^v1=[0-9a-f]{64}$/))).toBe(true);
  });

  describe.each(accepted.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    it.each(encodings(Buffer.from(v.bodyBase64, "base64")))(
      "is accepted with 200 and stores what the event says ($label)",
      async ({ base64 }) => {
        const response = await run(v, base64);

        expect(response).toEqual({ statusCode: 200 }); // no body, no headers
        const decision = stored()?.clientDecision as Record<string, unknown> | undefined;
        expect(decision, "a decision is stored on the request").toBeDefined();
        const e = v.expect!;
        expect(decision!.decision).toBe(e.decision);
        if (e.reason === null) {
          expect(decision).not.toHaveProperty("reason");
        } else if (v.name !== LINE_SEPARATORS) {
          expect(decision!.reason).toBe(e.reason);
          // "byte for byte": the UTF-8 bytes are equal too (a lone surrogate or a changed
          // character would show here, not in a lenient string comparison).
          expect(Buffer.from(String(decision!.reason), "utf8").equals(Buffer.from(e.reason, "utf8"))).toBe(true);
        }
        // `at` is the moment of the event, in UTC ("ISO 8601, UTC" in docs/api.md).
        expect(decision!.at).toMatch(/Z$/);
        expect(Date.parse(String(decision!.at))).toBe(e.atMs);
        expect(stored()?.decisionAtMs).toBe(e.atMs);
        expect(decision!.eventId).toBe(e.eventId);
        // The delivery status and the owner are untouched.
        expect(stored()).toMatchObject({ status: "sent", pk: "USER#qa-owner", subject: "Order 42" });
      },
    );
  });

  it("a reason with U+2028 and U+0085 is stored unchanged (XML 1.0 line ends: only CR and CR LF change)", async () => {
    const v = vectors.find((candidate) => candidate.name === LINE_SEPARATORS)!;
    await run(v, true);
    expect((stored()?.clientDecision as { reason?: string }).reason).toBe(v.expect!.reason);
  });

  describe.each(refused.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    it.each(encodings(Buffer.from(v.bodyBase64, "base64")))("is refused with 401, no body, nothing stored ($label)", async ({ base64 }) => {
      ddb.resetHistory();
      const response = await run(v, base64);

      expect(response).toEqual({ statusCode: 401 });
      expect(stored()).not.toHaveProperty("clientDecision");
      // "nothing expensive happens before the signature is right": the table is not touched.
      expect(ddb.calls()).toHaveLength(0);
    });
  });
});
