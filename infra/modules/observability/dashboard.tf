# One dashboard for the whole delivery flow, read top to bottom:
# alarms -> deliveries and their latency -> the worker and the queue -> the table -> the API -> the log archiver.
#
# 28 metric lines, inside the free tier (3 dashboards of up to 50 metrics each). Counted the
# strict way: every line, also the one that only feeds a metric-math expression and the second
# percentile of the same metric. The grid is 24 columns wide, every row holds three widgets of 8
# columns. A dashboard body is checked only when it is applied, so a typo in this JSON shows up
# at `terraform apply`, not at `validate`.

locals {
  region = data.aws_region.current.region

  # Every alarm of the project: the ones of this module and the ones defined elsewhere.
  alarm_arns = concat(
    [
      aws_cloudwatch_metric_alarm.worker_errors.arn,
      aws_cloudwatch_metric_alarm.webhook_errors.arn,
      aws_cloudwatch_metric_alarm.worker_duration.arn,
      aws_cloudwatch_metric_alarm.api_5xx.arn,
      aws_cloudwatch_metric_alarm.queue_age.arn,
      aws_cloudwatch_metric_alarm.table_write_throttled.arn,
      aws_cloudwatch_metric_alarm.webhook_unauthorized.arn,
      aws_cloudwatch_metric_alarm.log_guard_hits.arn,
    ],
    var.other_alarm_arns,
  )

  # The same 80 % of the timeout as the duration alarm (milliseconds), drawn as a line.
  worker_duration_alarm_ms = var.worker_timeout_seconds * 800

  widgets = [
    # --- What this is, and the state of every alarm -------------------------------------------
    {
      type = "text", x = 0, y = 0, width = 24, height = 4
      properties = {
        markdown = join("\n\n", [
          "## ${var.name_prefix}: delivery pipeline",
          "A request goes API -> table -> stream -> enqueuer -> queue -> **delivery-worker** -> the recipient; the recipient's decision comes back through the webhook. Top: the alarms. Then the deliveries and how long they take, the worker and the queue, the requests table, the API.",
          "Sent, rejected, failed and retried deliveries are counted from the worker's log lines; the two latency graphs are metrics the worker writes itself (namespace `${var.namespace}`). Log lines: docs/api.md, \"Logs\". Saved Logs Insights queries: `${var.name_prefix}/...`.",
        ])
      }
    },
    {
      type = "alarm", x = 0, y = 4, width = 24, height = 3
      properties = {
        title  = "Alarms"
        alarms = local.alarm_arns
      }
    },

    # --- Deliveries ---------------------------------------------------------------------------
    {
      type = "metric", x = 0, y = 7, width = 8, height = 6
      properties = {
        title   = "Deliveries by outcome (per 5 min)"
        region  = local.region
        view    = "timeSeries"
        stacked = true
        stat    = "Sum"
        period  = 300
        yAxis   = { left = { min = 0 } }
        metrics = [
          [var.namespace, "DeliverySent", { label = "Sent", color = "#2ca02c" }],
          [var.namespace, "DeliveryRejected", { label = "Rejected", color = "#ff7f0e" }],
          [var.namespace, "DeliveryFailed", { label = "Failed", color = "#d62728" }],
          [var.namespace, "DeliveryRetried", { label = "Retried", color = "#1f77b4" }],
        ]
      }
    },
    {
      type = "metric", x = 8, y = 7, width = 8, height = 6
      properties = {
        title  = "Time from creation to sent (ms)"
        region = local.region
        view   = "timeSeries"
        period = 300
        yAxis  = { left = { min = 0 } }
        metrics = [
          [var.namespace, "TimeToSentMs", { stat = "p50", label = "p50" }],
          [var.namespace, "TimeToSentMs", { stat = "p95", label = "p95" }],
        ]
      }
    },
    {
      type = "metric", x = 16, y = 7, width = 8, height = 6
      properties = {
        title  = "Recipient's answer time (ms)"
        region = local.region
        view   = "timeSeries"
        period = 300
        yAxis  = { left = { min = 0 } }
        metrics = [
          [var.namespace, "PartnerMs", { stat = "p50", label = "p50" }],
          [var.namespace, "PartnerMs", { stat = "p95", label = "p95" }],
        ]
      }
    },

    # --- Worker and queue ---------------------------------------------------------------------
    {
      type = "metric", x = 0, y = 13, width = 8, height = 6
      properties = {
        title  = "Delivery-worker errors (per 5 min)"
        region = local.region
        view   = "timeSeries"
        stat   = "Sum"
        period = 300
        yAxis  = { left = { min = 0 } }
        metrics = [
          ["AWS/Lambda", "Errors", "FunctionName", var.worker_function_name, { label = "Errors" }],
        ]
      }
    },
    {
      type = "metric", x = 8, y = 13, width = 8, height = 6
      properties = {
        title  = "Delivery-worker duration p95 (ms)"
        region = local.region
        view   = "timeSeries"
        period = 300
        yAxis  = { left = { min = 0 } }
        metrics = [
          ["AWS/Lambda", "Duration", "FunctionName", var.worker_function_name, { stat = "p95", label = "p95" }],
        ]
        annotations = {
          horizontal = [
            { label = "Alarm (80 % of timeout)", value = local.worker_duration_alarm_ms },
            { label = "Timeout", value = var.worker_timeout_seconds * 1000 },
          ]
        }
      }
    },
    {
      type = "metric", x = 16, y = 13, width = 8, height = 6
      properties = {
        title  = "Deliveries queue: waiting, DLQ, oldest age (alarm at 600 s)"
        region = local.region
        view   = "timeSeries"
        stat   = "Maximum"
        period = 300
        yAxis  = { left = { min = 0 }, right = { min = 0 } }
        metrics = [
          ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", var.queue_name, { label = "Waiting" }],
          ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", var.dlq_name, { label = "In the DLQ" }],
          ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", var.queue_name, { label = "Oldest message (s)", yAxis = "right" }],
        ]
      }
    },

    # --- Requests table -----------------------------------------------------------------------
    # The table is provisioned (5 read and 5 write units per second, docs/api.md). Consumed units
    # come as a Sum per period, so the expression divides by the period to get units per second,
    # which is what the provisioned line means. That line is the table's own metric (published
    # every 5 minutes), so it follows the table if somebody changes its capacity.
    {
      type = "metric", x = 0, y = 19, width = 8, height = 6
      properties = {
        title  = "Requests table: read units per second"
        region = local.region
        view   = "timeSeries"
        stat   = "Sum"
        period = 60
        yAxis  = { left = { min = 0 } }
        metrics = [
          [{ expression = "m1/PERIOD(m1)", label = "Consumed", id = "e1" }],
          ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", var.table_name, { id = "m1", visible = false }],
          ["AWS/DynamoDB", "ProvisionedReadCapacityUnits", "TableName", var.table_name, { stat = "Average", period = 300, label = "Provisioned" }],
        ]
      }
    },
    {
      type = "metric", x = 8, y = 19, width = 8, height = 6
      properties = {
        title  = "Requests table: write units per second"
        region = local.region
        view   = "timeSeries"
        stat   = "Sum"
        period = 60
        yAxis  = { left = { min = 0 } }
        metrics = [
          [{ expression = "m1/PERIOD(m1)", label = "Consumed", id = "e1" }],
          ["AWS/DynamoDB", "ConsumedWriteCapacityUnits", "TableName", var.table_name, { id = "m1", visible = false }],
          ["AWS/DynamoDB", "ProvisionedWriteCapacityUnits", "TableName", var.table_name, { stat = "Average", period = 300, label = "Provisioned" }],
        ]
      }
    },
    {
      type = "metric", x = 16, y = 19, width = 8, height = 6
      properties = {
        title  = "Requests table: throttled events (per 5 min)"
        region = local.region
        view   = "timeSeries"
        stat   = "Sum"
        period = 300
        yAxis  = { left = { min = 0 } }
        metrics = [
          ["AWS/DynamoDB", "ReadThrottleEvents", "TableName", var.table_name, { label = "Reads" }],
          ["AWS/DynamoDB", "WriteThrottleEvents", "TableName", var.table_name, { label = "Writes" }],
        ]
      }
    },

    # --- API and log-based signals ------------------------------------------------------------
    {
      type = "metric", x = 0, y = 25, width = 8, height = 6
      properties = {
        title  = "API requests by result (per 5 min)"
        region = local.region
        view   = "timeSeries"
        stat   = "Sum"
        period = 300
        yAxis  = { left = { min = 0 } }
        metrics = [
          ["AWS/ApiGateway", "Count", "ApiId", var.api_id, { label = "All requests" }],
          ["AWS/ApiGateway", "4xx", "ApiId", var.api_id, { label = "4xx", color = "#ff7f0e" }],
          ["AWS/ApiGateway", "5xx", "ApiId", var.api_id, { label = "5xx", color = "#d62728" }],
        ]
      }
    },
    {
      type = "metric", x = 8, y = 25, width = 8, height = 6
      properties = {
        title  = "API latency (ms)"
        region = local.region
        view   = "timeSeries"
        period = 300
        yAxis  = { left = { min = 0 } }
        metrics = [
          ["AWS/ApiGateway", "Latency", "ApiId", var.api_id, { stat = "p50", label = "p50" }],
          ["AWS/ApiGateway", "Latency", "ApiId", var.api_id, { stat = "p95", label = "p95" }],
        ]
      }
    },
    {
      type = "metric", x = 16, y = 25, width = 8, height = 6
      properties = {
        title  = "Unauthorized webhook calls and log guard hits (per 5 min)"
        region = local.region
        view   = "timeSeries"
        stat   = "Sum"
        period = 300
        yAxis  = { left = { min = 0 } }
        metrics = [
          [var.namespace, "WebhookUnauthorized", { label = "Unauthorized webhook calls" }],
          [var.namespace, "LogGuardHits", { label = "Log guard hits" }],
        ]
      }
    },
    {
      # No alarm for the archiver: the account is at the 10 free alarms already. A failed batch
      # (Errors above 0) is seen here, and Lambda has retried it twice by then.
      type = "metric", x = 0, y = 31, width = 8, height = 6
      properties = {
        title  = "Log archiver: runs and errors (per 5 min)"
        region = local.region
        view   = "timeSeries"
        stat   = "Sum"
        period = 300
        yAxis  = { left = { min = 0 } }
        metrics = [
          ["AWS/Lambda", "Invocations", "FunctionName", var.archiver_function_name, { label = "Runs" }],
          ["AWS/Lambda", "Errors", "FunctionName", var.archiver_function_name, { label = "Errors" }],
        ]
      }
    },
  ]
}

resource "aws_cloudwatch_dashboard" "delivery" {
  dashboard_name = "${var.name_prefix}-delivery"
  dashboard_body = jsonencode({ widgets = local.widgets })
}
