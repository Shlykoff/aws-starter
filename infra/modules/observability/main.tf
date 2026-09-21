# Custom metrics counted from log lines (metric filters), the alarms on them and on the built-in
# metrics (alarms.tf), one dashboard (dashboard.tf) and saved Logs Insights queries (queries.tf).
#
# Everything here is sized for the CloudWatch free tier (10 custom metrics, 10 alarms, 3
# dashboards of up to 50 metrics, 5 GB of logs). The metric budget is 8 of 10:
#   6 counted here from log lines: DeliverySent, DeliveryRejected, DeliveryFailed, DeliveryRetried,
#     WebhookUnauthorized, LogGuardHits;
#   2 written by the delivery-worker itself as embedded-metric-format lines (they are durations,
#     which a metric filter cannot compute): TimeToSentMs and PartnerMs. Only the dashboard
#     mentions them.
# All of them are in ONE namespace and have NO dimensions. A dimension would multiply the count
# (one metric per function or per outcome value) and use up the 10 at once, so the outcome is in
# the metric name instead.

data "aws_region" "current" {}

locals {
  # Filter terms. The log line of a Lambda function in the default text format is
  #   <timestamp><TAB><request id><TAB><LEVEL><TAB>{"level":"info","message":...}
  # A whole line like that is not JSON, so a JSON filter pattern ({ $.event = "x" }) never matches
  # it. A term pattern is a plain substring match on the raw line, which does. A term is written
  # between double quotes, and a double quote inside it is escaped with a backslash, so the JSON
  # text "event":"request_sent" is the pattern "\"event\":\"request_sent\"". This relies on the
  # logger writing compact JSON (no space after the colon), which it does.
  json_pair = "\"\\\"%s\\\":\\\"%s\\\"\""

  # One metric per log-line kind. Several terms in one pattern must ALL be present. `value = 1`
  # in the filter below: every matching line counts once.
  counted = {
    delivery-sent = {
      metric    = "DeliverySent"
      log_group = var.worker_log_group_name
      pattern   = format(local.json_pair, "event", "request_sent")
    }
    delivery-rejected = {
      metric    = "DeliveryRejected"
      log_group = var.worker_log_group_name
      pattern   = format(local.json_pair, "event", "request_rejected")
    }
    delivery-failed = {
      metric    = "DeliveryFailed"
      log_group = var.worker_log_group_name
      pattern   = format(local.json_pair, "event", "request_failed")
    }
    # An attempt that the worker will try again (the recipient answered with an error or did not
    # answer). "delivery_attempted" alone would also count the final ones, so the outcome is
    # required too.
    delivery-retried = {
      metric    = "DeliveryRetried"
      log_group = var.worker_log_group_name
      pattern   = "${format(local.json_pair, "event", "delivery_attempted")} ${format(local.json_pair, "outcome", "retry")}"
    }
    # Calls to the public webhook route that failed the signature check. A few now and then are
    # a clock or a token problem; many are somebody guessing.
    webhook-unauthorized = {
      metric    = "WebhookUnauthorized"
      log_group = var.webhook_log_group_name
      pattern   = format(local.json_pair, "outcome", "unauthorized")
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "counted" {
  for_each = local.counted

  name           = "${var.name_prefix}-${each.key}"
  log_group_name = each.value.log_group
  pattern        = each.value.pattern

  metric_transformation {
    name      = each.value.metric
    namespace = var.namespace
    value     = "1"
    unit      = "Count"
    # No default_value: a period without a matching line has NO data point instead of a zero.
    # That costs nothing (a zero would be one more stored data point every minute), and the
    # alarms below treat missing data as "not breaching".
  }
}

# The log guard (docs/api.md, "Logs") replaces a value it does not allow with "[unlisted]" or
# "[rejected]". Such a line means that code logged something the list of allowed fields does not
# cover, so it is a bug to fix, in any function. One filter per log group, but all of them publish
# the SAME metric name in the same namespace, so together they are ONE metric. `?` makes a term
# optional and the pattern needs at least one of the optional terms: either word matches.
resource "aws_cloudwatch_log_metric_filter" "log_guard" {
  for_each = var.lambda_log_group_names

  name           = "${var.name_prefix}-log-guard-${each.key}"
  log_group_name = each.value
  pattern        = "?\"[unlisted]\" ?\"[rejected]\""

  metric_transformation {
    name      = "LogGuardHits"
    namespace = var.namespace
    value     = "1"
    unit      = "Count"
  }
}
