# Eight alarms. With the two in envs/dev/main.tf (the DLQ and the enqueuer's iterator age) the
# project has 10, which is the free tier: 10 alarms with ONE metric each. That is why no alarm
# here uses a metric-math expression (an alarm is billed per metric in its expression), and why
# there must not be an eleventh.
#
# All of them notify the same topic and treat missing data as "not breaching". Lambda, SQS and
# the API report nothing while nothing happens, and so do the metric filters (no default_value):
# an idle system is the normal state, and it should rest in OK, not in INSUFFICIENT_DATA.
#
# Five-minute periods: enough to ignore one slow call, quick enough for a demo. Each description
# says what to look at, because it is the text of the e-mail.

# --- Lambda ------------------------------------------------------------------------------------

# The worker returns the ids of the messages it could not deliver (a partial batch response),
# which Lambda does not count as an error. So an error here is a crash or a timeout of the
# function itself.
resource "aws_cloudwatch_metric_alarm" "worker_errors" {
  alarm_name        = "${var.name_prefix}-delivery-worker-errors"
  alarm_description = "The delivery-worker crashed or timed out. Look at its log group for the line 'Delivery attempt crashed' or a timeout REPORT, then at the deliveries DLQ."

  namespace   = "AWS/Lambda"
  metric_name = "Errors"
  dimensions  = { FunctionName = var.worker_function_name }
  statistic   = "Sum"

  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "webhook_errors" {
  alarm_name        = "${var.name_prefix}-receive-webhook-errors"
  alarm_description = "receive-webhook failed with an error of ours (a 500 to the recipient, which will send the event again). Look at its log group for the line 'Webhook failed'."

  namespace   = "AWS/Lambda"
  metric_name = "Errors"
  dimensions  = { FunctionName = var.webhook_function_name }
  statistic   = "Sum"

  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alarm_topic_arn]
}

# 80 % of the timeout: a worker that regularly needs more than that will soon hit the timeout,
# and a timeout means the message comes back and the recipient is called twice. The 95th
# percentile, not the maximum: one slow call must not wake anybody. `extended_statistic` is how
# a percentile is asked for (`statistic` takes only Sum, Average, Minimum, Maximum, SampleCount).
resource "aws_cloudwatch_metric_alarm" "worker_duration" {
  alarm_name        = "${var.name_prefix}-delivery-worker-duration-p95"
  alarm_description = "The delivery-worker's 95th-percentile duration is over 80 % of its timeout. Look at the partnerMs of the delivery_attempted events: the recipient is probably slow."

  namespace          = "AWS/Lambda"
  metric_name        = "Duration"
  dimensions         = { FunctionName = var.worker_function_name }
  extended_statistic = "p95"

  period              = 300
  evaluation_periods  = 1
  threshold           = var.worker_timeout_seconds * 800 # 80 % of the timeout, in milliseconds (the metric's unit)
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alarm_topic_arn]
}

# --- API Gateway ---------------------------------------------------------------------------------

# An HTTP API reports its metrics as `Count`, `4xx`, `5xx`, `Latency` and `IntegrationLatency`
# (a REST API has 4XXError and 5XXError instead). Dimension ApiId alone covers the whole API, and
# there is only the $default stage; the dimension pair ApiId + Stage also exists.
resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name        = "${var.name_prefix}-api-5xx"
  alarm_description = "The API answered a request with a 5xx status. Look at the API access log (status, routeKey) and at the log group of that route's function."

  namespace   = "AWS/ApiGateway"
  metric_name = "5xx"
  dimensions  = { ApiId = var.api_id }
  statistic   = "Sum"

  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alarm_topic_arn]
}

# --- SQS -----------------------------------------------------------------------------------------

# A message that waits more than 10 minutes means that nothing is taking messages (the worker is
# failing or throttled) or that one message group is stuck: a FIFO queue hands out the messages
# of a group one at a time, so a failing message holds back the ones behind it.
resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name        = "${var.name_prefix}-deliveries-queue-age"
  alarm_description = "The oldest message in the deliveries queue has waited more than 10 minutes. Look at the worker's errors and duration, and at whether the recipient is answering."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateAgeOfOldestMessage" # seconds
  dimensions  = { QueueName = var.queue_name }
  statistic   = "Maximum"

  period              = 300
  evaluation_periods  = 1
  threshold           = 600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alarm_topic_arn]
}

# --- DynamoDB ------------------------------------------------------------------------------------

# ONE metric per alarm, so the choice was between three:
#  - ThrottledRequests covers reads and writes, but DynamoDB publishes it only with the dimension
#    pair TableName + Operation. An alarm needs the exact dimensions, so it would take one alarm
#    per operation (PutItem, UpdateItem, GetItem, Query, ...): far over the 10.
#  - A metric-math alarm on ReadThrottleEvents + WriteThrottleEvents is billed as two alarm
#    metrics, which makes 11.
#  - WriteThrottleEvents (dimension TableName) is one metric. It watches the write path, which
#    is what matters: creating a request, every status change, the webhook. That is where a
#    throttle turns into lost work. A throttled read reaches the same people anyway: the SDK
#    retries it, and if it still fails the handler answers 500 (the API 5xx alarm) or the worker
#    crashes (the worker Errors alarm). ReadThrottleEvents is on the dashboard.
# Not covered: the by-request-id index, whose throttles are published with the extra dimension
# GlobalSecondaryIndexName. It gets one small write per new request, like the table.
resource "aws_cloudwatch_metric_alarm" "table_write_throttled" {
  alarm_name        = "${var.name_prefix}-requests-table-write-throttled"
  alarm_description = "DynamoDB throttled a write to the requests table: it is over its 5 provisioned write units. Look at the table's consumed write capacity on the dashboard, then at what is writing."

  namespace   = "AWS/DynamoDB"
  metric_name = "WriteThrottleEvents"
  dimensions  = { TableName = var.table_name }
  statistic   = "Sum"

  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alarm_topic_arn]
}

# --- Custom metrics (metric filters in main.tf) --------------------------------------------------

# 5 in 5 minutes, not 1: a single 401 is what a wrong clock or a rotated token looks like
# during a demo.
resource "aws_cloudwatch_metric_alarm" "webhook_unauthorized" {
  alarm_name        = "${var.name_prefix}-webhook-unauthorized"
  alarm_description = "Five or more webhook calls failed the signature check within 5 minutes. Look at the signatureProblem field in the receive-webhook log group: a rotated token, or somebody guessing."

  namespace   = var.namespace
  metric_name = "WebhookUnauthorized"
  statistic   = "Sum"

  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "log_guard_hits" {
  alarm_name        = "${var.name_prefix}-log-guard-hits"
  alarm_description = "The log guard replaced a value in a log line ([unlisted] or [rejected]): code logs a field that is not on the allowed list. Run the saved query 'log-guard-hits' to find the function and the field name."

  namespace   = var.namespace
  metric_name = "LogGuardHits"
  statistic   = "Sum"

  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [var.alarm_topic_arn]
}
