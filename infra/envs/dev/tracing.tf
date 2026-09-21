# Traces: one trace per request, from create-request through the DynamoDB stream, the enqueuer and
# the queue to the delivery-worker, the call to the recipient and the decision webhook.
#
# Two halves. The code (backend/src/lib/tracing.ts) uses only the OpenTelemetry API: it stores a
# trace context on the request item and passes it in the queue message, because neither the stream
# nor the HTTP webhook carries one. The SDK and the exporter come from an AWS-published Lambda
# layer, which this file attaches to the traced functions (`traced = true` in main.tf).
#
# The layer sends the spans straight to the X-Ray OTLP endpoint, signed with the function's role:
# no collector to run. AWS requires CloudWatch "Transaction Search" for that endpoint (last part of
# this file). Details and the alternatives that were rejected: README, Decisions.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  # AWS's own layer for Node.js (account 615299751070 is AWS's, the same in every region). One ARN
  # for x86_64 and arm64. Version 14 (April 2026) lists nodejs24.x; its start-up script puts an
  # ES-module handler on the import-hook path built for bundled code (our functions are one
  # bundled index.mjs). The version is pinned on purpose: a new one is taken deliberately, after a
  # check of the cold start and the memory (docs/api.md, "Traces").
  otel_layers = ["arn:aws:lambda:${data.aws_region.current.region}:615299751070:layer:AWSOpenTelemetryDistroJs:14"]

  # 512 MB, not 256: the SDK and the exporter live inside the function, and running out of memory
  # would fail the delivery (a message that fails five times goes to the dead-letter queue). More
  # memory also means more CPU, which shortens the start-up. Cost: nothing at this volume (the free
  # tier is 400,000 GB-seconds a month).
  traced_memory_mb = 512

  otel_environment = {
    # The layer's start-up script: runs the OpenTelemetry SDK before our code.
    AWS_LAMBDA_EXEC_WRAPPER = "/opt/otel-instrument"

    # The layer also feeds CloudWatch Application Signals (its own metrics and service map),
    # billed separately. We want the traces only.
    OTEL_AWS_APPLICATION_SIGNALS_ENABLED = "false"

    # What the layer instruments by itself: Lambda invocations (added by the script), and here the
    # calls made with fetch (the call to the recipient). Calls made with the AWS SDK are not
    # instrumented this way: the SDK is inlined in our bundle, where the layer cannot hook it; the
    # code wraps those calls itself (tracedPort).
    OTEL_NODE_ENABLED_INSTRUMENTATIONS = "undici"
  }
}

# ---------------------------------------------------------------------------
# CloudWatch Transaction Search: where the spans go
# ---------------------------------------------------------------------------

# The spans are stored as structured logs in the group `aws/spans`. It is not created here: AWS
# reserves the names that start with `aws/` (CreateLogGroup refuses them), and X-Ray creates it
# itself when the destination below is switched. Its retention is looked at after the first apply.
# Ingestion is billed as any log ingestion, inside the 5 GB free a month; a span is about a kilobyte.

# Lets X-Ray write into the two groups Transaction Search uses, on behalf of this account only.
resource "aws_cloudwatch_log_resource_policy" "xray_spans" {
  policy_name = "TransactionSearchXRayAccess"

  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TransactionSearchXRayAccess"
      Effect    = "Allow"
      Principal = { Service = "xray.amazonaws.com" }
      Action    = "logs:PutLogEvents"
      Resource = [
        "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:aws/spans:*",
        "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/application-signals/data:*",
      ]
      Condition = {
        ArnLike      = { "aws:SourceArn" = "arn:aws:xray:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:*" }
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })
}

# From now on X-Ray keeps spans in CloudWatch Logs (all of them, not a sample) instead of its own
# store. This is an account-wide setting of the region, and it also applies to the traces that
# Lambda's active tracing records for the other functions.
resource "aws_xray_trace_segment_destination" "this" {
  destination = "CloudWatchLogs"

  depends_on = [aws_cloudwatch_log_resource_policy.xray_spans]
}

# Every span is searchable in the logs. On top of that a share of the traces is indexed as trace
# summaries, which is what the X-Ray console lists and filters: 1 % is free, more is billed. At
# this volume 1 % is a few traces a day; the rest are found by trace id (it is in the logs of the
# request events) or in the span log group.
resource "aws_xray_indexing_rule" "default" {
  name = "Default"

  rule {
    probabilistic {
      desired_sampling_percentage = 1
    }
  }

  depends_on = [aws_xray_trace_segment_destination.this]
}
