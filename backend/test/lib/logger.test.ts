import { describe, expect, it } from "vitest";
import { describeError } from "../../src/lib/errors";
import { LogGuardError, MAX_MESSAGE_LENGTH } from "../../src/lib/log-fields";
import { createLogger } from "../../src/lib/logger";
import { captureLogs } from "../helpers/logs";

const CANARY = "CANARY-secret-text-9f3a";
// The tests run with LOG_STRICT=1 (vitest.config.ts). Where a test is about what the guard does
// in Lambda, where it must never throw, it asks for the lenient mode explicitly.
const lenient = { strict: false };

describe("createLogger", () => {
  it("writes one JSON object per line with level, message and fields", () => {
    const logs = captureLogs();

    createLogger("info").info("Request handled", { route: "GET /requests", statusCode: 200 });

    expect(logs.entries()).toEqual([
      { level: "info", message: "Request handled", route: "GET /requests", statusCode: 200 },
    ]);
  });

  it("drops lines below the configured level", () => {
    const logs = captureLogs();
    const logger = createLogger("warn");

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(logs.entries().map((entry) => entry.level)).toEqual(["warn", "error"]);
  });

  it("writes everything at debug level", () => {
    const logs = captureLogs();
    const logger = createLogger("debug");

    logger.debug("d");
    logger.info("i");

    expect(logs.entries().map((entry) => entry.level)).toEqual(["debug", "info"]);
  });

  it("adds the fields of a child logger to every line, without changing the parent", () => {
    const logs = captureLogs();
    const parent = createLogger("info", { awsRequestId: "abc-123" });
    const child = parent.child({ requestId: "01M30JDSMHY8CRX59V35WV731S" });

    child.info("from child", { sent: 1 });
    parent.info("from parent");

    expect(logs.entries()).toEqual([
      { level: "info", message: "from child", awsRequestId: "abc-123", requestId: "01M30JDSMHY8CRX59V35WV731S", sent: 1 },
      { level: "info", message: "from parent", awsRequestId: "abc-123" },
    ]);
  });

  it("leaves out a field whose value is undefined, as JSON does", () => {
    const logs = captureLogs();

    createLogger("info").info("x", { httpStatus: undefined, outcome: "applied" });

    expect(logs.entries()).toEqual([{ level: "info", message: "x", outcome: "applied" }]);
  });
});

describe("the log guard: which fields may be written", () => {
  it.each(["subject", "body", "text", "partner", "recipient", "description", "xml", "token", "signature", "authorization", "apiKey", "email"])(
    "a field named %s is not on the list: the name stays, the value never reaches the log",
    (name) => {
      const logs = captureLogs();

      createLogger("info", {}, lenient).info("x", { [name]: CANARY });

      expect(logs.entries()).toEqual([{ level: "info", message: "x", [name]: "[unlisted]" }]);
      expect(logs.lines.join("\n")).not.toContain(CANARY);
    },
  );

  it("throws in strict mode, and what it throws names the field but never quotes the value", () => {
    captureLogs();

    const attempt = () => createLogger("info").info("x", { subject: CANARY });

    expect(attempt).toThrow(LogGuardError);
    expect(attempt).toThrow(/the field "subject" is not on the list/);
    try {
      attempt();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(CANARY);
    }
  });

  it("does not throw in lenient mode: logging must never break a handler", () => {
    const logs = captureLogs();

    expect(() => createLogger("info", {}, lenient).info("x", { subject: CANARY, requestId: "not an id" })).not.toThrow();
    expect(logs.entries()).toEqual([{ level: "info", message: "x", subject: "[unlisted]", requestId: "[rejected]" }]);
  });

  it("checks the fields of a child logger, at the moment a line is written", () => {
    const logs = captureLogs();
    const child = createLogger("info", {}, lenient).child({ partner: CANARY });

    child.info("x");

    expect(logs.entries()).toEqual([{ level: "info", message: "x", partner: "[unlisted]" }]);
  });

  it("does not let a field replace the level or the message of the line", () => {
    const logs = captureLogs();

    createLogger("info", {}, lenient).info("real message", { level: "debug", message: CANARY });

    expect(logs.entries()).toEqual([{ level: "info", message: "real message" }]);
  });

  it("does not write a field NAME that could carry data", () => {
    const logs = captureLogs();

    createLogger("info", {}, lenient).info("x", { [`a name with ${CANARY}`]: 1, "requestId ": "x" });

    expect(logs.lines.join("\n")).not.toContain(CANARY);
    expect(logs.entries()).toEqual([{ level: "info", message: "x" }]);
  });
});

describe("the log guard: what a value must look like", () => {
  it("lets the fixed word of a reason through and stops prose in the same field", () => {
    const logs = captureLogs();
    const logger = createLogger("info", {}, lenient);

    logger.info("worker", { reason: "http_503" });
    logger.info("event", { reason: `Out of stock: ${CANARY}` });

    expect(logs.entries().map((entry) => entry.reason)).toEqual(["http_503", "[rejected]"]);
    expect(logs.lines.join("\n")).not.toContain(CANARY);
  });

  it.each([
    ["requestId", "01M30JDSMHY8CRX59V35WV731S", `see ${CANARY}`],
    ["outcome", "applied", `two words ${CANARY}`],
    ["httpStatus", 200, `200 ${CANARY}`],
    ["httpStatus", 503, Number.NaN],
    ["replyValid", true, "true"],
    ["route", "POST /requests/{id}/retry", `POST /requests/${CANARY}`],
  ])("%s: %j passes, %j does not", (name, good, bad) => {
    const logs = captureLogs();
    const logger = createLogger("info", {}, lenient);

    logger.info("x", { [name]: good });
    logger.info("x", { [name]: bad });

    expect(logs.entries().map((entry) => entry[name])).toEqual([good, "[rejected]"]);
  });

  it("lets a list of validator findings through and rejects the whole list for one bad item", () => {
    const logs = captureLogs();
    const logger = createLogger("info", {}, lenient);

    logger.info("x", { problems: ["Subject: does not match the allowed pattern", "(document): DOCTYPE not allowed"] });
    logger.info("x", { problems: ["Subject: does not match the allowed pattern", `Text: ${CANARY} <b>`] });

    expect(logs.entries().map((entry) => entry.problems)).toEqual([
      ["Subject: does not match the allowed pattern", "(document): DOCTYPE not allowed"],
      "[rejected]",
    ]);
  });

  it("does not write nested objects: they could hold anything", () => {
    const logs = captureLogs();

    createLogger("info", {}, lenient).info("x", { problems: { subject: CANARY }, status: { nested: CANARY } });

    expect(logs.lines.join("\n")).not.toContain(CANARY);
    expect(logs.entries()).toEqual([{ level: "info", message: "x", problems: "[rejected]", status: "[rejected]" }]);
  });
});

describe("the log guard: the text of an error", () => {
  it("replaces every quoted piece: parsers quote the value that made them fail", () => {
    const logs = captureLogs();
    let error: unknown;
    try {
      JSON.parse(`{"subject": ${CANARY}}`); // a real Node error: it quotes a piece of the input
    } catch (caught) {
      error = caught;
    }
    // (This is the kind of message that reached the logs when a handler logged what JSON.parse threw.)
    expect(String((error as Error).message)).toContain("CANARY");

    createLogger("info").error("Delivery attempt crashed", describeError(error));

    expect(logs.lines.join("\n")).not.toContain(CANARY);
    expect(logs.entries()[0]).toMatchObject({ errorName: "SyntaxError" });
  });

  it.each([`a 'quoted ${CANARY}' value`, `a "quoted ${CANARY}" value`, `a \`quoted ${CANARY}\` value`])(
    "scrubs a quoted value in %s",
    (text) => {
      const logs = captureLogs();

      createLogger("info").error("x", describeError(new Error(text)));

      expect(logs.lines.join("\n")).not.toContain(CANARY);
    },
  );

  it("cuts a long message and a long stack", () => {
    const logs = captureLogs();

    createLogger("info").error("x", { errorMessage: "m".repeat(5000), stack: "s".repeat(9000) });

    const [entry] = logs.entries() as { errorMessage: string; stack: string }[];
    expect(entry?.errorMessage.length).toBeLessThan(320);
    expect(entry?.errorMessage.endsWith("…[cut]")).toBe(true);
    expect(entry?.stack.length).toBeLessThan(2020);
  });

  it("keeps what is useful: the name of the error and a message without quotes", () => {
    const logs = captureLogs();

    createLogger("info").error("x", describeError(new TypeError("Cannot read properties of undefined (reading x)")));

    expect(logs.entries()[0]).toMatchObject({
      errorName: "TypeError",
      errorMessage: "Cannot read properties of undefined (reading x)",
    });
  });
});

describe("the log guard: the message of a line", () => {
  it("is a fixed sentence: a long one or one with line breaks is cut, and strict mode says so", () => {
    const logs = captureLogs();
    const long = `Handled ${CANARY} ${"x".repeat(200)}`;

    createLogger("info", {}, lenient).info(long);
    createLogger("info", {}, lenient).info(`two\nlines ${CANARY}`);

    const messages = logs.entries().map((entry) => String(entry.message));
    expect(messages[0]?.length).toBe(MAX_MESSAGE_LENGTH);
    expect(messages[1]).not.toContain("\n");
    expect(() => createLogger("info").info(long)).toThrow(/message is longer/);
  });
});
