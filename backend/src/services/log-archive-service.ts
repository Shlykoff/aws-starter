import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import type { Logger } from "../lib/logger";
import type { LogArchiveStore } from "../repositories/log-archive-store";

// What CloudWatch Logs sends to a subscription filter's destination: the JSON below, gzipped
// and then base64-encoded. Only the parts this service uses are checked. The rest passes
// through (`looseObject`), because the archive keeps the envelope as it came: Athena reads
// it later (`extractedFields` on an event, for one, exists only for some filter patterns).
const logEventSchema = z.looseObject({
  id: z.string(),
  // Epoch milliseconds. The upper bound is the last millisecond of the year 9999: a later
  // date has a six-digit year in ISO form, and the day folder below would not be YYYY-MM-DD.
  // (Older than 1970 is not a log line either.)
  timestamp: z.number().int().min(0).max(253_402_300_799_999),
  message: z.string(),
});
const envelopeSchema = z.looseObject({
  messageType: z.string(),
  logEvents: z.array(logEventSchema),
});
type Envelope = z.infer<typeof envelopeSchema>;

// Why a batch cannot be read: a fixed word for the log, never a value (see decode).
type Unreadable = "not_gzip" | "not_json" | "wrong_shape";

// base64 -> gunzip -> JSON -> shape. Every step that fails gives a reason word and nothing
// else: the error message of a parser or of zod may quote the input, and the input is the
// log lines of other functions.
function decode(payload: string): { envelope: Envelope } | { unreadable: Unreadable } {
  let text: string;
  try {
    // Buffer.from(..., "base64") never throws, it skips what is not base64. Garbage then
    // fails at the next step, gunzip.
    text = gunzipSync(Buffer.from(payload, "base64")).toString("utf8");
  } catch {
    return { unreadable: "not_gzip" };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { unreadable: "not_json" };
  }

  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) return { unreadable: "wrong_shape" };
  return { envelope: parsed.data };
}

// Copies one batch of CloudWatch log events into S3, as JSON lines that Athena can read:
// one gzipped object per UTC day that the batch has events of, one line (the envelope) in it.
//
// Idempotency: the key is the SHA-256 of the line. Lambda retries a failed asynchronous
// invocation with the same batch, and the same batch always gives the same key, so a retry
// overwrites the object it wrote before and the archive never holds a line twice.
export class LogArchiveService {
  constructor(private readonly store: LogArchiveStore) {}

  async archive(payload: string, log: Logger): Promise<{ records: number; objects: number }> {
    const decoded = decode(payload);
    if ("unreadable" in decoded) {
      // Returned, not thrown: a batch that cannot be read now cannot be read on a retry
      // either, and a retry would only repeat the error. It is logged, so it is seen.
      log.error("Log batch is not readable", { reason: decoded.unreadable });
      return { records: 0, objects: 0 };
    }
    const { envelope } = decoded;

    // CloudWatch checks that the destination works with a CONTROL_MESSAGE. It holds no logs.
    if (envelope.messageType !== "DATA_MESSAGE") return { records: 0, objects: 0 };

    // A line is filed under the day it was logged, so a batch that spans midnight UTC
    // makes two objects. (A Map keeps the order of insertion: the events stay in order.)
    const byDay = new Map<string, Envelope["logEvents"]>();
    for (const event of envelope.logEvents) {
      const day = new Date(event.timestamp).toISOString().slice(0, 10); // YYYY-MM-DD
      const events = byDay.get(day) ?? [];
      events.push(event);
      byDay.set(day, events);
    }

    let records = 0;
    for (const [day, logEvents] of byDay) {
      const line = `${JSON.stringify({ ...envelope, logEvents })}\n`;
      const hash = createHash("sha256").update(line).digest("hex").slice(0, 32);
      // Hive-style folders (year=.../month=.../day=...) let Athena skip the days a query does not need.
      const key = `logs/year=${day.slice(0, 4)}/month=${day.slice(5, 7)}/day=${day.slice(8, 10)}/${hash}.json.gz`;

      // A failing store call is not caught: the invocation fails and Lambda retries it, which
      // can help (a throttled or a briefly unavailable S3), and the retry is safe (see above).
      await this.store.put(key, gzipSync(line));
      records += logEvents.length;
    }
    log.info("Log batch archived", { records, objects: byDay.size });
    return { records, objects: byDay.size };
  }
}
