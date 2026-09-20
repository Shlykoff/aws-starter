import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/lib/logger";
import { captureLogs } from "../helpers/logs";

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
    const parent = createLogger("info", { service: "requests" });
    const child = parent.child({ awsRequestId: "abc-123" });

    child.info("from child", { extra: 1 });
    parent.info("from parent");

    expect(logs.entries()).toEqual([
      { level: "info", message: "from child", service: "requests", awsRequestId: "abc-123", extra: 1 },
      { level: "info", message: "from parent", service: "requests" },
    ]);
  });
});
