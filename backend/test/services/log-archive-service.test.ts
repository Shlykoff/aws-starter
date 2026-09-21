import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/lib/logger";
import type { LogArchiveStore } from "../../src/repositories/log-archive-store";
import { LogArchiveService } from "../../src/services/log-archive-service";
import { captureLogs } from "../helpers/logs";
import { dataMessage, encodeBatch, logEvent, objectText } from "../helpers/log-batches";

// The service with a fake store that keeps the objects in a Map (the key overwrites, as in S3)
// and REAL gzip: the objects are unpacked and read back the way Athena would read them.
class FakeStore implements LogArchiveStore {
  readonly objects = new Map<string, Uint8Array>();
  puts = 0;
  failWith: Error | undefined;

  put(key: string, body: Uint8Array): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.puts += 1;
    this.objects.set(key, body);
    return Promise.resolve();
  }

  /** The stored line(s), unpacked, by key. */
  text(key: string): string {
    const body = this.objects.get(key);
    if (body === undefined) throw new Error(`no object at ${key}`);
    return objectText(body);
  }
}

function setup() {
  const store = new FakeStore();
  const logs = captureLogs();
  const service = new LogArchiveService(store);
  const archive = (payload: string) => service.archive(payload, createLogger("debug"));
  return { store, logs, archive };
}

const at = (day: number, hour = 10, minute = 0, second = 0, ms = 0): number =>
  Date.UTC(2026, 8, day, hour, minute, second, ms); // September 2026

describe("LogArchiveService: what it archives", () => {
  it("writes nothing for a CONTROL_MESSAGE, CloudWatch's check that the destination works", async () => {
    const { store, logs, archive } = setup();
    const control = {
      messageType: "CONTROL_MESSAGE",
      owner: "CloudwatchLogs",
      logGroup: "",
      logStream: "",
      subscriptionFilters: [],
      logEvents: [
        { id: "", timestamp: at(21), message: "CWL CONTROL MESSAGE: Checking health of destination Lambda function." },
      ],
    };

    expect(await archive(encodeBatch(control))).toEqual({ records: 0, objects: 0 });

    expect(store.puts).toBe(0);
    expect(logs.entries().filter((entry) => entry.level === "error")).toEqual([]);
  });

  it("writes one object for one day, holding exactly one JSON line: the envelope with its events", async () => {
    const { store, logs, archive } = setup();
    const envelope = dataMessage([logEvent("1", at(21, 10)), logEvent("2", at(21, 11))]);

    expect(await archive(encodeBatch(envelope))).toEqual({ records: 2, objects: 1 });

    expect(store.objects.size).toBe(1);
    const [key] = [...store.objects.keys()];
    const text = store.text(key ?? "");
    // One line, ended by a line break: the format Athena reads (JSON lines).
    expect(text.endsWith("\n")).toBe(true);
    expect(text.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(text) as unknown).toEqual(envelope);
    expect(logs.entries()).toEqual([{ level: "info", message: "Log batch archived", records: 2, objects: 1 }]);
  });

  it("keeps every field of the envelope and of an event, also the ones it does not know", async () => {
    const { store, archive } = setup();
    // CloudWatch adds `extractedFields` to an event when the filter pattern extracts fields.
    const event = { ...logEvent("1", at(21)), extractedFields: { level: "error" } };
    const envelope = { ...dataMessage([event]), somethingNew: { added: "later" } };

    await archive(encodeBatch(envelope));

    const [key] = [...store.objects.keys()];
    expect(JSON.parse(store.text(key ?? "")) as unknown).toEqual(envelope);
  });

  it("files a line under the day it was logged: a batch across midnight UTC makes two objects", async () => {
    const { store, archive } = setup();
    const lastOfTheDay = logEvent("1", at(21, 23, 59, 59, 999));
    const firstOfTheNext = logEvent("2", at(22, 0, 0, 0, 0));
    const envelope = dataMessage([lastOfTheDay, firstOfTheNext]);

    expect(await archive(encodeBatch(envelope))).toEqual({ records: 2, objects: 2 });

    const keys = [...store.objects.keys()];
    const dayOne = keys.find((key) => key.includes("/day=21/"));
    const dayTwo = keys.find((key) => key.includes("/day=22/"));
    expect(keys).toHaveLength(2);
    expect(JSON.parse(store.text(dayOne ?? "")) as unknown).toEqual({ ...envelope, logEvents: [lastOfTheDay] });
    expect(JSON.parse(store.text(dayTwo ?? "")) as unknown).toEqual({ ...envelope, logEvents: [firstOfTheNext] });
  });

  it("keeps the order of the events inside a day, also when the days alternate", async () => {
    const { store, archive } = setup();
    const events = [
      logEvent("a", at(21, 23, 0)),
      logEvent("b", at(22, 0, 1)),
      logEvent("c", at(21, 23, 30)),
      logEvent("d", at(22, 0, 2)),
    ];

    await archive(encodeBatch(dataMessage(events)));

    const idsOf = (day: string) => {
      const key = [...store.objects.keys()].find((k) => k.includes(`/day=${day}/`));
      const line = JSON.parse(store.text(key ?? "")) as { logEvents: { id: string }[] };
      return line.logEvents.map((event) => event.id);
    };
    expect(idsOf("21")).toEqual(["a", "c"]);
    expect(idsOf("22")).toEqual(["b", "d"]);
  });

  it("writes nothing for a batch without events", async () => {
    const { store, archive } = setup();

    expect(await archive(encodeBatch(dataMessage([])))).toEqual({ records: 0, objects: 0 });

    expect(store.puts).toBe(0);
  });
});

describe("LogArchiveService: the key", () => {
  it("is logs/year=YYYY/month=MM/day=DD/<first 32 hex characters of the SHA-256 of the line>.json.gz", async () => {
    const { store, archive } = setup();

    await archive(encodeBatch(dataMessage([logEvent("1", at(21, 10))])));

    // The hash is a reference value computed outside the code: `shasum -a 256` of the line
    // below (with its line break) starts with c834ea32c452075ffc64a1eb394b60dd. The two fields
    // the service checks come first in the line: that is the order zod writes them in.
    expect([...store.objects.keys()]).toEqual([
      "logs/year=2026/month=09/day=21/c834ea32c452075ffc64a1eb394b60dd.json.gz",
    ]);
    expect(store.text("logs/year=2026/month=09/day=21/c834ea32c452075ffc64a1eb394b60dd.json.gz")).toBe(
      '{"messageType":"DATA_MESSAGE","logEvents":[{"id":"1","timestamp":1789984800000,"message":"line 1"}],' +
        '"owner":"000000000000","logGroup":"/aws/lambda/demo-dev-create-request",' +
        '"logStream":"2026/09/21/[$LATEST]0123456789abcdef0123456789abcdef","subscriptionFilters":["demo-dev-archive"]}\n',
    );
  });

  it("pads the month and the day with zero", async () => {
    const { store, archive } = setup();

    await archive(encodeBatch(dataMessage([logEvent("1", Date.UTC(2027, 0, 5, 12))])));

    expect([...store.objects.keys()][0]).toMatch(/^logs\/year=2027\/month=01\/day=05\/[0-9a-f]{32}\.json\.gz$/);
  });

  it("is the same for the same batch, so a retried invocation overwrites and does not duplicate", async () => {
    const { store, archive } = setup();
    const payload = encodeBatch(dataMessage([logEvent("1", at(21)), logEvent("2", at(22))]));

    await archive(payload);
    const firstKeys = [...store.objects.keys()].sort();
    const firstBodies = firstKeys.map((key) => store.text(key));
    await archive(payload);

    expect(store.puts).toBe(4); // written twice ...
    expect([...store.objects.keys()].sort()).toEqual(firstKeys); // ... to the same two keys
    expect(firstKeys.map((key) => store.text(key))).toEqual(firstBodies);
  });

  it("is another one for another batch", async () => {
    const { store, archive } = setup();

    await archive(encodeBatch(dataMessage([logEvent("1", at(21))])));
    await archive(encodeBatch(dataMessage([logEvent("2", at(21))])));

    expect(store.objects.size).toBe(2);
  });
});

describe("LogArchiveService: a batch that cannot be read", () => {
  // The log lines of other functions may hold anything, so a failure must never reveal a piece
  // of the payload. CANARY is in every payload below and must be in no log line.
  const CANARY = "CANARY-7f3a91";
  const gzipped = (text: string) => gzipSync(text).toString("base64");
  const withEvent = (event: Record<string, unknown>) => encodeBatch({ ...dataMessage([]), logEvents: [event] });
  const good = { id: "1", timestamp: at(21), message: CANARY };

  it.each([
    ["not base64 at all", `${CANARY} !!! not base64`, "not_gzip"],
    ["an empty payload", "", "not_gzip"],
    ["base64 of text that is not gzip", Buffer.from(CANARY).toString("base64"), "not_gzip"],
    ["a gzip of text that is not JSON", gzipped(`{ ${CANARY} `), "not_json"],
    ["a gzip of an empty text", gzipped(""), "not_json"],
    ["JSON that is not an object", gzipped(JSON.stringify(CANARY)), "wrong_shape"],
    ["JSON without messageType", gzipped(JSON.stringify({ logEvents: [good] })), "wrong_shape"],
    ["a messageType that is not text", gzipped(JSON.stringify({ messageType: 1, logEvents: [good] })), "wrong_shape"],
    ["logEvents that is not a list", gzipped(JSON.stringify({ messageType: "DATA_MESSAGE", logEvents: CANARY })), "wrong_shape"],
    ["an event without id", withEvent({ timestamp: at(21), message: CANARY }), "wrong_shape"],
    ["an event whose message is not text", withEvent({ ...good, message: { text: CANARY } }), "wrong_shape"],
    ["a timestamp that is a text", withEvent({ ...good, timestamp: String(at(21)) }), "wrong_shape"],
    ["a timestamp with a fraction", withEvent({ ...good, timestamp: at(21) + 0.5 }), "wrong_shape"],
    ["a negative timestamp", withEvent({ ...good, timestamp: -1 }), "wrong_shape"],
    ["a timestamp beyond the largest Date", withEvent({ ...good, timestamp: 8.64e15 + 1 }), "wrong_shape"],
    ["a timestamp in the year 10000, whose ISO date has six digits", withEvent({ ...good, timestamp: 253_402_300_800_000 }), "wrong_shape"],
  ])("%s: writes nothing, does not throw, logs a reason and none of the payload", async (_name, payload, reason) => {
    const { store, logs, archive } = setup();

    expect(await archive(payload)).toEqual({ records: 0, objects: 0 });

    expect(store.puts).toBe(0);
    expect(logs.entries()).toEqual([{ level: "error", message: "Log batch is not readable", reason }]);
    expect(logs.lines.join("\n")).not.toContain("CANARY");
  });

  it("accepts the edges of the timestamp range: 1970-01-01 and the last millisecond of 9999", async () => {
    const { store, archive } = setup();

    const result = await archive(
      encodeBatch(dataMessage([logEvent("1", 0), logEvent("2", 253_402_300_799_999)])),
    );

    expect(result).toEqual({ records: 2, objects: 2 });
    expect([...store.objects.keys()].sort()).toEqual([
      expect.stringMatching(/^logs\/year=1970\/month=01\/day=01\//) as string,
      expect.stringMatching(/^logs\/year=9999\/month=12\/day=31\//) as string,
    ]);
  });
});

describe("LogArchiveService: a store that fails", () => {
  it("lets the failure reach the caller, so that Lambda retries the invocation", async () => {
    const { store, logs, archive } = setup();
    store.failWith = new Error("S3 is unavailable");

    await expect(archive(encodeBatch(dataMessage([logEvent("1", at(21))])))).rejects.toThrow("S3 is unavailable");

    expect(logs.entries().filter((entry) => entry.message === "Log batch archived")).toEqual([]);
  });
});
