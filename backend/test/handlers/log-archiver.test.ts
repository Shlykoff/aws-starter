import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../../src/handlers/log-archiver";
import { lambdaContext } from "../helpers/events";
import { dataMessage, logEvent, logsEvent, objectText } from "../helpers/log-batches";
import { captureLogs } from "../helpers/logs";

// The real handler, service, store and container. Only the S3 client's `send` is replaced, by
// a recorder. ARCHIVE_BUCKET comes from vitest.config.ts.
const s3 = mockClient(S3Client);
let logs: ReturnType<typeof captureLogs>;

beforeEach(() => {
  s3.reset();
  s3.on(PutObjectCommand).resolves({});
  logs = captureLogs();
});
afterAll(() => {
  s3.restore();
});

const puts = () => s3.commandCalls(PutObjectCommand).map((call) => call.args[0].input);

describe("log-archiver handler", () => {
  it("writes the batch to the archive bucket as a gzipped JSON line, under the day of its events", async () => {
    const envelope = dataMessage([logEvent("1", Date.UTC(2026, 8, 21, 10)), logEvent("2", Date.UTC(2026, 8, 21, 11))]);

    await handler(logsEvent(envelope), lambdaContext());

    expect(puts()).toHaveLength(1);
    const input = puts()[0];
    expect(input?.Bucket).toBe("test-log-archive");
    expect(input?.Key).toMatch(/^logs\/year=2026\/month=09\/day=21\/[0-9a-f]{32}\.json\.gz$/);
    expect(JSON.parse(objectText(input?.Body as Uint8Array)) as unknown).toEqual(envelope);
  });

  it("logs the outcome with the request id of the invocation", async () => {
    await handler(logsEvent(dataMessage([logEvent("1", Date.UTC(2026, 8, 21, 10))])), lambdaContext("req-1"));

    expect(logs.entries()).toEqual([
      { level: "info", message: "Log batch archived", awsRequestId: "req-1", records: 1, objects: 1 },
    ]);
  });

  it("answers the health check (a CONTROL_MESSAGE) without writing anything", async () => {
    const control = { ...dataMessage([]), messageType: "CONTROL_MESSAGE" };

    await expect(handler(logsEvent(control), lambdaContext())).resolves.toBeUndefined();

    expect(puts()).toEqual([]);
  });

  it("does not fail on a batch it cannot read: a retry could not read it either", async () => {
    await expect(handler({ awslogs: { data: "not a batch" } }, lambdaContext("req-2"))).resolves.toBeUndefined();

    expect(puts()).toEqual([]);
    expect(logs.entries()).toEqual([
      { level: "error", message: "Log batch is not readable", awsRequestId: "req-2", reason: "not_gzip" },
    ]);
  });

  it("fails when S3 fails, so that Lambda retries the invocation", async () => {
    s3.on(PutObjectCommand).rejects(new Error("SlowDown"));

    await expect(
      handler(logsEvent(dataMessage([logEvent("1", Date.UTC(2026, 8, 21, 10))])), lambdaContext()),
    ).rejects.toThrow("SlowDown");
  });
});
