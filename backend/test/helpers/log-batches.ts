import type { CloudWatchLogsEvent } from "aws-lambda";
import { gunzipSync, gzipSync } from "node:zlib";

// Builders for what a CloudWatch Logs subscription filter sends: the JSON envelope, gzipped,
// then base64-encoded, in `awslogs.data`. The values are fake.

export interface TestLogEvent {
  id: string;
  timestamp: number;
  message: string;
}

/** A DATA_MESSAGE envelope, as CloudWatch delivers it. */
export function dataMessage(logEvents: TestLogEvent[]) {
  return {
    messageType: "DATA_MESSAGE",
    owner: "000000000000",
    logGroup: "/aws/lambda/demo-dev-create-request",
    logStream: "2026/09/21/[$LATEST]0123456789abcdef0123456789abcdef",
    subscriptionFilters: ["demo-dev-archive"],
    logEvents,
  };
}

/** One log event, at the given UTC time. */
export function logEvent(id: string, timestamp: number, message = `line ${id}`): TestLogEvent {
  return { id, timestamp, message };
}

/** The payload string of a batch: base64 of the gzip of the JSON text. */
export function encodeBatch(envelope: unknown): string {
  return gzipSync(JSON.stringify(envelope)).toString("base64");
}

/** The whole Lambda event of a batch. */
export function logsEvent(envelope: unknown): CloudWatchLogsEvent {
  return { awslogs: { data: encodeBatch(envelope) } };
}

/** What a stored object holds: its text, gunzipped (one JSON line per envelope). */
export function objectText(body: Uint8Array): string {
  return gunzipSync(body).toString("utf8");
}
