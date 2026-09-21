// Two numbers of the delivery are published as CloudWatch metrics, so that they can be graphed
// with percentiles and alarmed on: how long a request took from creation to `sent`, and how long
// the recipient took to answer. Everything else that is counted (deliveries by outcome, webhook
// rejections, log guard hits) is counted by CloudWatch itself from the log lines, with metric
// filters (infra/modules/observability); a filter can count lines but cannot read a number out of
// a line that Lambda has prefixed with a time and an id, so these two use the Embedded Metric
// Format (EMF).
//
// EMF: a log line that is one JSON object with an `_aws` block naming the metric. CloudWatch Logs
// reads the block and publishes the metric; no API call, no IAM permission, nothing to wait for in
// the function. (AWS warns that the JSON log format of Lambda can break EMF for Node.js; this
// project keeps the default text format.)
//
// The set of metrics is closed and has no dimensions: every combination of dimension values is a
// metric of its own, and the free tier has 10 (docs/api.md, "Logs"). The line carries only a
// number, never text, so it needs no field guard (lib/log-fields.ts).

const METRICS = {
  /** Creation of the request to its status `sent`, milliseconds. */
  TimeToSentMs: "Milliseconds",
  /** The HTTP call to the recipient, milliseconds. */
  PartnerMs: "Milliseconds",
} as const;

export type MetricName = keyof typeof METRICS;

// What CloudWatch accepts as a namespace (letters, digits and . - _ / # : , at most 255).
const NAMESPACE = /^[A-Za-z0-9._#:/-]{1,255}$/;

/**
 * Publishes one value of a metric. It does nothing when METRICS_NAMESPACE is not set (the tests, a
 * local run) or is not a valid namespace, and for a value that is not a finite, non-negative
 * number: a metric must never make a handler fail.
 */
export function recordMetric(name: MetricName, value: number): void {
  const namespace = process.env.METRICS_NAMESPACE;
  if (namespace === undefined || !NAMESPACE.test(namespace)) return;
  if (!Number.isFinite(value) || value < 0) return;

  console.info(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        // Dimensions [[]]: one set with no dimension, so the metric is a single series.
        CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [[]], Metrics: [{ Name: name, Unit: METRICS[name] }] }],
      },
      [name]: value,
    }),
  );
}
