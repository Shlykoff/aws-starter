import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { HttpPartnerClient } from "../../src/clients/http-partner-client";
import { buildSubmissionXml } from "../../src/domain/submission-xml";
import { readAnswer } from "../../src/domain/reply-reader";
import { createRealValidator, expected, fixture } from "../helpers/contracts";

// The real HttpPartnerClient, XSD validator and reply reader against a RUNNING partner-sim
// (the independent Python recipient of partner-sim/). It checks that the two implementations
// of the contract agree in practice, not only on the fixtures.
//
// It is skipped unless both variables are set, so `yarn test` stays hermetic. To run it:
//
//   cd partner-sim && docker compose up -d --build partner-sim      # uses partner-sim/.env
//   cd .. && PARTNER_SIM_URL=http://127.0.0.1:8080 PARTNER_SIM_KEY=<PARTNER_API_KEY of that .env> \
//       yarn workspace @aws-starter/backend test test/integration
//   cd partner-sim && docker compose down                           # when finished
//
// Every message gets a fresh ULID: the recipient answers a known MessageId with its stored
// answer, so a fixed id would make a second run see the first run's answers.
const baseUrl = process.env.PARTNER_SIM_URL;
const apiKey = process.env.PARTNER_SIM_KEY;

describe.skipIf(baseUrl === undefined || apiKey === undefined)("against a running partner-sim", () => {
  const client = new HttpPartnerClient({ baseUrl: baseUrl ?? "http://127.0.0.1:8080" });
  const validator = createRealValidator();

  // Sends a document and reads the answer exactly as the worker does.
  async function deliverRaw(xml: string, id: string, key = apiKey ?? "") {
    const answer = await client.send({ xml, idempotencyKey: id, apiKey: key });
    const replyCheck = answer.kind === "answer" && answer.body !== undefined ? await validator.validateReply(answer.body) : undefined;
    return { answer, replyCheck, reading: readAnswer(answer, replyCheck, id) };
  }

  // The XML the worker would build for these values.
  function build(overrides: { subject?: string; text?: string; senderEmail?: string; id?: string } = {}) {
    const id = overrides.id ?? ulid();
    const built = buildSubmissionXml({
      messageId: id,
      sentAt: new Date(),
      senderEmail: overrides.senderEmail ?? "sender@example.test",
      subject: overrides.subject ?? "Integration test",
      text: overrides.text ?? "Hello from the integration test.",
    });
    if (!built.ok) throw new Error("expected the XML to be built");
    return { id, xml: built.xml };
  }

  it("accepts a valid submission: 200 + Accepted is delivered, and the Reply is valid and about our id", async () => {
    const { id, xml } = build();

    const { answer, replyCheck, reading } = await deliverRaw(xml, id);

    expect(answer).toMatchObject({ kind: "answer", httpStatus: 200 });
    expect(replyCheck).toEqual({ valid: true });
    expect(reading).toMatchObject({ decision: "delivered", reason: "accepted" });
    expect(reading.facts).toMatchObject({ status: "Accepted", relatesTo: id });
  });

  it("answers a repeated MessageId with the same stored answer (the recipient deduplicates)", async () => {
    const { id, xml } = build();

    const first = await deliverRaw(xml, id);
    const second = await deliverRaw(xml, id);

    expect(second.reading.decision).toBe("delivered");
    expect(second.reading.facts?.messageId).toBe(first.reading.facts?.messageId);
  });

  it("accepts text that needed escaping and characters outside ASCII", async () => {
    const { id, xml } = build({
      senderEmail: "Smith & Sons, Inc.",
      subject: "Fish & chips <3 «Привет» 😀",
      text: "a > b ]]> c\r\nline two\tindented\n</Text><Injected/>",
    });

    const { reading } = await deliverRaw(xml, id);

    expect(reading).toMatchObject({ decision: "delivered" });
  });

  it("refuses for good what the recipient's own rules refuse: 422 + Rejected + RECIPIENT_REJECTED", async () => {
    const { id, xml } = build({ subject: "[reject] please" });

    const { answer, reading } = await deliverRaw(xml, id);

    expect(answer).toMatchObject({ httpStatus: 422 });
    expect(reading).toMatchObject({ decision: "refused", reason: "rejected" });
    expect(reading.facts).toMatchObject({ status: "Rejected", code: "RECIPIENT_REJECTED", relatesTo: id });
  });

  it("retries a 503 without a body ([fail] makes the recipient temporarily unavailable)", async () => {
    const { id, xml } = build({ subject: "[fail] please" });

    const { answer, reading } = await deliverRaw(xml, id);

    expect(answer).toEqual({ kind: "answer", httpStatus: 503, body: undefined });
    expect(reading).toMatchObject({ decision: "retry", reason: "http_503" });
  });

  it("retries a wrong key: 401 is our own configuration, not a refusal", async () => {
    const { id, xml } = build();

    const { answer, reading } = await deliverRaw(xml, id, "not-the-key");

    expect(answer).toEqual({ kind: "answer", httpStatus: 401, body: undefined });
    expect(reading).toMatchObject({ decision: "retry", reason: "http_401" });
  });

  it("refuses a document over 64 KiB: 413 is our request being wrong", async () => {
    const { id, xml } = build();

    const { answer, reading } = await deliverRaw(`${xml}<!-- ${"x".repeat(70_000)} -->`, id);

    expect(answer).toMatchObject({ httpStatus: 413 });
    expect(reading).toMatchObject({ decision: "refused", reason: "http_413" });
  });

  it("retries when nobody is listening", async () => {
    const nobody = new HttpPartnerClient({ baseUrl: "http://127.0.0.1:1" });
    const { id, xml } = build();

    const answer = await nobody.send({ xml, idempotencyKey: id, apiKey: "k" });

    expect(answer).toEqual({ kind: "no-answer", reason: "network_error" });
    expect(readAnswer(answer, undefined, id).decision).toBe("retry");
  });

  // Both sides run every fixture of contracts/fixtures/expected.json. The recipient must say
  // what expected.json says, and the sender must read the answer the way the contract says.
  describe.each(Object.entries(expected.submission))("fixture %s (%s)", (name, want) => {
    it("gets the answer the contract expects, and the sender reads it correctly", async () => {
      // A fresh id, except where the id itself is what the fixture is about.
      const original = fixture("submission", name);
      const aboutTheId = name.includes("message-id");
      const id = ulid();
      const xml = aboutTheId ? original : original.replace(/<MessageId>[^<]*<\/MessageId>/, `<MessageId>${id}</MessageId>`);

      const { answer, replyCheck, reading } = await deliverRaw(xml, id);

      const status = answer.kind === "answer" ? answer.httpStatus : undefined;
      expect(status).toBe(want === "valid" ? 200 : want === "SCHEMA_INVALID" ? 422 : 400);
      expect(replyCheck).toEqual({ valid: true }); // every Reply of the recipient is valid against reply.xsd
      expect(reading.decision).toBe(want === "valid" ? "delivered" : "refused");
      if (want !== "valid") {
        expect(reading.facts).toMatchObject({ status: "Rejected", code: want });
      }
    });
  });
});
