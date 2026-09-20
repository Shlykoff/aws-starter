import { describe, expect, it } from "vitest";
import { handler } from "../../src/handlers/partner-mock";
import { lambdaContext } from "../helpers/events";
import { captureLogs } from "../helpers/logs";
import { functionUrlEvent } from "../helpers/pipeline-events";

// The real handler. It needs no AWS and no state, so nothing is replaced.
const call = (subject: string, extra: Record<string, unknown> = {}) =>
  handler(
    functionUrlEvent({
      body: JSON.stringify({ id: "r1", partner: "Acme", subject, body: "Please ship.", ...extra }),
      headers: { "idempotency-key": "01J8Z3K5W0ABCDEFGHJKMNPQR1" },
    }),
    lambdaContext(),
  );

// The handler returns the object form of the response; asserting on it needs this narrowing.
const parts = (response: Awaited<ReturnType<typeof call>>) => {
  const { statusCode, body, headers } = response as { statusCode: number; body: string; headers: Record<string, string> };
  return { statusCode, headers, json: JSON.parse(body) as unknown };
};

describe("partner-mock", () => {
  it("accepts a normal request: 200 { accepted: true }", async () => {
    const { statusCode, json, headers } = parts(await call("Order 42"));

    expect(statusCode).toBe(200);
    expect(json).toEqual({ accepted: true });
    expect(headers["content-type"]).toBe("application/json");
  });

  it("refuses a subject containing [reject] with 422 and an error", async () => {
    const { statusCode, json } = parts(await call("Order 42 [reject]"));

    expect(statusCode).toBe(422);
    expect(json).toEqual({ error: expect.any(String) as string });
  });

  it("fails a subject containing [fail] with 503", async () => {
    const { statusCode, json } = parts(await call("[fail] Order 42"));

    expect(statusCode).toBe(503);
    expect(json).toEqual({ error: expect.any(String) as string });
  });

  it("finds the marker anywhere in the subject", async () => {
    expect(parts(await call("Order [reject] 42")).statusCode).toBe(422);
    expect(parts(await call("Order [fail] 42")).statusCode).toBe(503);
  });

  it("looks only at the subject, not at the other fields", async () => {
    const { statusCode } = parts(await call("Order 42", { body: "[reject] [fail]", partner: "[fail]" }));

    expect(statusCode).toBe(200);
  });

  it("lets [reject] win when a subject has both markers", async () => {
    expect(parts(await call("[fail] [reject]")).statusCode).toBe(422);
  });

  it("keeps no state: the same request gets the same answer every time", async () => {
    const answers = [await call("Order 42 [fail]"), await call("Order 42"), await call("Order 42 [fail]")];

    expect(answers.map((answer) => parts(answer).statusCode)).toEqual([503, 200, 503]);
  });

  it("reads a base64-encoded body", async () => {
    const body = Buffer.from(JSON.stringify({ subject: "x [reject]" }), "utf8").toString("base64");

    const response = await handler(functionUrlEvent({ body, isBase64Encoded: true }), lambdaContext());

    expect(parts(response).statusCode).toBe(422);
  });

  it.each([
    ["no body", undefined],
    ["a body that is not JSON", "{oops"],
    ["JSON without a subject", '{"partner":"Acme"}'],
    ["a subject that is not a string", '{"subject":42}'],
  ])("answers 400 for %s", async (_label, body) => {
    const response = await handler(functionUrlEvent({ body }), lambdaContext());

    const { statusCode, json } = parts(response);
    expect(statusCode).toBe(400);
    expect(json).toEqual({ error: expect.any(String) as string });
  });

  it("logs the status and the idempotency key, and never the body", async () => {
    const logs = captureLogs();

    await call("Order 42 [reject]");

    expect(logs.entries()).toEqual([
      {
        level: "info",
        message: "Partner mock answered",
        awsRequestId: "test-lambda-request-id",
        statusCode: 422,
        idempotencyKey: "01J8Z3K5W0ABCDEFGHJKMNPQR1",
      },
    ]);
    expect(logs.lines.join("\n")).not.toContain("Order 42");
    expect(logs.lines.join("\n")).not.toContain("Please ship.");
  });
});
