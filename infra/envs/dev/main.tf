locals {
  prefix = "${var.project}-${var.env}" # every resource name is <project>-<env>-<thing>

  # One entry per Lambda. The routes are the ones in docs/api.md; each function gets
  # exactly one DynamoDB action, the one its handler needs.
  functions = {
    create-request = { route_key = "POST /requests", dynamodb_action = "dynamodb:PutItem" }
    list-requests  = { route_key = "GET /requests", dynamodb_action = "dynamodb:Query" }
    get-request    = { route_key = "GET /requests/{id}", dynamodb_action = "dynamodb:GetItem" }
  }

  # Origins the browser app runs on: Vite's dev server always, CloudFront when it exists.
  # They feed both CORS (API) and the login redirects (Cognito). The for-expression is
  # empty when the static site is switched off.
  site_origins = [for site in module.static_site : "https://${site.domain_name}"]
  web_origins  = concat(["http://localhost:5173"], local.site_origins)
}

module "requests_table" {
  source = "../../modules/dynamodb"

  name = "${local.prefix}-requests"
}

module "function" {
  source   = "../../modules/lambda-function"
  for_each = local.functions

  name       = "${local.prefix}-${each.key}"
  source_dir = "${var.backend_dist_dir}/${each.key}"

  environment = {
    TABLE_NAME   = module.requests_table.name
    LOG_LEVEL    = "info"
    NODE_OPTIONS = "--enable-source-maps" # the build is minified: stack traces map back to the TypeScript source
  }

  policy_statements = [{
    actions   = [each.value.dynamodb_action]
    resources = [module.requests_table.arn]
  }]
}

module "cognito" {
  source = "../../modules/cognito"

  name_prefix   = local.prefix
  domain_prefix = var.cognito_domain_prefix
  web_origins   = local.web_origins
}

module "api" {
  source = "../../modules/http-api"

  name            = "${local.prefix}-api"
  allowed_origins = local.web_origins
  jwt_issuer      = module.cognito.issuer
  jwt_audience    = [module.cognito.client_id]

  routes = {
    for name, fn in local.functions : name => {
      route_key     = fn.route_key
      function_name = module.function[name].name
      invoke_arn    = module.function[name].invoke_arn
    }
  }
}

# Optional: whether CloudFront can be used on this account has not been verified.
module "static_site" {
  source = "../../modules/static-site"
  count  = var.enable_static_site ? 1 : 0

  name = "${local.prefix}-site"
}

# ---------------------------------------------------------------------------
# Delivery pipeline (docs/api.md, "Delivery pipeline"):
#   table stream -> enqueuer -> SQS FIFO -> delivery-worker -> partner-mock
# with SNS notices, an S3 audit copy and two alarms.
# ---------------------------------------------------------------------------

locals {
  # Numbers that must agree with each other are defined once, here.
  worker_timeout_seconds = 15 # timeout of the delivery-worker (docs/api.md)

  # The queue refuses to be created if this is below 6 x worker_timeout_seconds.
  delivery_visibility_timeout_seconds = 120

  # Receives after which SQS moves a message to the DLQ. The worker gets the same number as
  # MAX_RECEIVE_COUNT, so it knows which attempt is the last one.
  delivery_max_receive_count = 5

  # Set on every function of the pipeline (docs/api.md, "Lambda contract").
  common_environment = {
    LOG_LEVEL    = "info"
    NODE_OPTIONS = "--enable-source-maps" # the build is minified: stack traces map back to the TypeScript source
  }
}

module "deliveries_queue" {
  source = "../../modules/sqs-fifo"

  name                       = "${local.prefix}-deliveries"
  visibility_timeout_seconds = local.delivery_visibility_timeout_seconds
  consumer_timeout_seconds   = local.worker_timeout_seconds
  max_receive_count          = local.delivery_max_receive_count
}

# The worker publishes one event per terminal status, but only the bad outcomes are mailed
# (the filter policy): a successful delivery (`sent`) sends no e-mail.
module "request_status_topic" {
  source = "../../modules/sns-topic"

  name          = "${local.prefix}-request-status"
  email         = var.notification_email
  filter_policy = { status = ["failed", "rejected"] }
}

# Alarms and the enqueuer's failure destination; every message is mailed.
module "alerts_topic" {
  source = "../../modules/sns-topic"

  name                    = "${local.prefix}-alerts"
  email                   = var.notification_email
  allow_cloudwatch_alarms = true # the two alarms below publish here
}

module "audit_bucket" {
  source = "../../modules/audit-bucket"

  name = "${local.prefix}-deliveries"
}

# The stand-in for the partner's system. Its Function URL is IAM-protected, so it is not a
# public endpoint; only the delivery-worker is allowed to call it (statements below).
module "partner_mock" {
  source = "../../modules/lambda-function"

  name       = "${local.prefix}-partner-mock"
  source_dir = "${var.backend_dist_dir}/partner-mock"
  timeout    = 10

  enable_function_url = true

  environment = local.common_environment

  # No policy_statements: it needs no table, queue or bucket (the module adds logging).
}

module "enqueuer" {
  source = "../../modules/lambda-function"

  name       = "${local.prefix}-enqueuer"
  source_dir = "${var.backend_dist_dir}/enqueuer"
  timeout    = 10

  environment = merge(local.common_environment, {
    TABLE_NAME = module.requests_table.name
    QUEUE_URL  = module.deliveries_queue.url
  })

  policy_statements = [
    {
      # Reading the stream, on this stream only. These are the four stream actions of the AWS
      # managed policy AWSLambdaDynamoDBExecutionRole, which AWS's own DynamoDB Streams
      # tutorial also grants on the stream ARN.
      actions = [
        "dynamodb:DescribeStream",
        "dynamodb:GetRecords",
        "dynamodb:GetShardIterator",
        "dynamodb:ListStreams",
      ]
      resources = [module.requests_table.stream_arn]
    },
    {
      actions   = ["sqs:SendMessage"]
      resources = [module.deliveries_queue.arn]
    },
    {
      actions   = ["dynamodb:UpdateItem"] # sets the status `queued`
      resources = [module.requests_table.arn]
    },
    {
      # The mapping publishes to its failure destination with this function's role, so the
      # role needs the permission (AWS docs, "Retain discarded records for a DynamoDB event
      # source").
      actions   = ["sns:Publish"]
      resources = [module.alerts_topic.arn]
    },
  ]
}

resource "aws_lambda_event_source_mapping" "enqueuer" {
  function_name    = module.enqueuer.arn
  event_source_arn = module.requests_table.stream_arn

  # TRIM_HORIZON = start from the oldest record still in the stream. AWS warns that a mapping
  # just created or updated can take minutes to start polling, and with LATEST the records
  # written in that window can be missed. Requests stored before the stream existed are in no
  # stream record, so they are not delivered either way. If the mapping is ever recreated
  # (changing this argument replaces it), the records of the last 24 h are enqueued again;
  # that is harmless, the queue's deduplication and the worker's status check absorb repeats.
  starting_position = "TRIM_HORIZON"

  # Only new requests. The pipeline's own status updates are MODIFY events, and the
  # enqueuer must not see them again.
  filter_criteria {
    filter {
      pattern = jsonencode({ eventName = ["INSERT"] })
    }
  }

  batch_size = 10 # SendMessageBatch takes at most 10 messages (docs/api.md)

  # The function returns the sequence number of the first record it could not handle; Lambda
  # retries from that record on and does not repeat the records before it. Bisecting splits a
  # failed batch in two and retries the halves, which isolates a bad record; splitting does
  # not use up the retries below.
  function_response_types        = ["ReportBatchItemFailures"]
  bisect_batch_on_function_error = true

  # Without limits a bad record can block its shard for the whole 24 h the stream keeps
  # records, so both are set (the numbers are judgment calls). The retries stop a record that
  # keeps failing; the age limit also covers records Lambda cannot even hand to the function
  # (throttling), which do not count as retries. 10 retries ride out a short outage; 1 hour
  # leaves time to react to the IteratorAge alarm (5 minutes) and most of the 24 h to look at
  # the stream afterwards. A record given up on stays `created` in the table.
  maximum_retry_attempts        = 10
  maximum_record_age_in_seconds = 3600

  # What happens to a given-up record: Lambda sends a message about it (which shard and which
  # sequence numbers, not the request text) to the alerts topic.
  destination_config {
    on_failure {
      destination_arn = module.alerts_topic.arn
    }
  }
}

module "delivery_worker" {
  source = "../../modules/lambda-function"

  name       = "${local.prefix}-delivery-worker"
  source_dir = "${var.backend_dist_dir}/delivery-worker"
  timeout    = local.worker_timeout_seconds

  environment = merge(local.common_environment, {
    TABLE_NAME        = module.requests_table.name
    PARTNER_URL       = module.partner_mock.function_url
    TOPIC_ARN         = module.request_status_topic.arn
    AUDIT_BUCKET      = module.audit_bucket.name
    MAX_RECEIVE_COUNT = tostring(local.delivery_max_receive_count) # environment variables are strings
  })

  policy_statements = [
    {
      # What the SQS event source mapping needs (the AWS managed policy
      # AWSLambdaSQSQueueExecutionRole has the same three actions, on every queue).
      actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      resources = [module.deliveries_queue.arn]
    },
    {
      actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"] # read the status, then set sent / rejected / failed
      resources = [module.requests_table.arn]
    },
    {
      actions   = ["sns:Publish"]
      resources = [module.request_status_topic.arn]
    },
    {
      actions   = ["s3:PutObject"] # only the audit copies, nothing else in the bucket
      resources = ["${module.audit_bucket.arn}/deliveries/*"]
    },
    {
      # Calling a Function URL with auth type AWS_IAM takes two permissions on the target
      # function (AWS docs, "Control access to Lambda function URLs"; both are required for
      # URLs created since October 2025). Because the caller is in the same account, these
      # identity-policy statements are enough: partner-mock needs no resource-based policy.
      actions   = ["lambda:InvokeFunctionUrl"]
      resources = [module.partner_mock.arn]
      conditions = [{
        test     = "StringEquals"
        variable = "lambda:FunctionUrlAuthType"
        values   = ["AWS_IAM"]
      }]
    },
    {
      # The second permission, limited to calls that come through the URL: the worker cannot
      # invoke partner-mock with the plain Invoke API.
      actions   = ["lambda:InvokeFunction"]
      resources = [module.partner_mock.arn]
      conditions = [{
        test     = "Bool"
        variable = "lambda:InvokedViaFunctionUrl"
        values   = ["true"]
      }]
    },
  ]
}

resource "aws_lambda_event_source_mapping" "delivery_worker" {
  function_name    = module.delivery_worker.arn
  event_source_arn = module.deliveries_queue.arn

  # One message per invocation. A FIFO batch can hold messages of several partners; when one
  # fails, the worker hands the rest of the batch back untried (docs/api.md), and each of
  # those messages is charged a receive every time, so behind a failing partner they could
  # reach the DLQ without ever being delivered. With one message per batch a failure affects
  # only that message. A demo needs no more throughput than this.
  batch_size = 1

  # The function returns the ids of the messages it could not deliver; only those go back to
  # the queue (docs/api.md, "delivery-worker").
  function_response_types = ["ReportBatchItemFailures"]

  # The account allows 10 concurrent executions in total, and each running worker also
  # holds one for the partner call. 2 is the smallest value Lambda accepts.
  scaling_config {
    maximum_concurrency = 2
  }
}

# ---------------------------------------------------------------------------
# Alarms. Both notify the alerts topic.
#
# Missing data must not count as breaching. With no traffic these metrics have no data
# points (SQS reports a queue's metrics only while the queue is active; the enqueuer runs
# only when the stream has records), and that is the normal state here. "notBreaching"
# treats such periods as within the threshold, so an idle alarm rests in OK instead of
# drifting to INSUFFICIENT_DATA.
# ---------------------------------------------------------------------------

# Anything in the DLQ is a delivery that ran out of attempts and needs a look.
resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name        = "${local.prefix}-deliveries-dlq-not-empty"
  alarm_description = "A delivery message ran out of attempts and is in the dead-letter queue. Inspect it, then redrive or delete it."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible" # SQS's recommended metric for watching a DLQ
  dimensions  = { QueueName = module.deliveries_queue.dlq_name }
  statistic   = "Maximum"

  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [module.alerts_topic.arn]
}

# IteratorAge = how old the newest record of the last batch was when the function got it.
# Growing means the enqueuer is stuck or failing, so requests wait in status `created`.
# Stream records are kept for 24 h, so this has to fire long before that.
resource "aws_cloudwatch_metric_alarm" "enqueuer_iterator_age" {
  alarm_name        = "${local.prefix}-enqueuer-iterator-age"
  alarm_description = "The enqueuer is more than 5 minutes behind the table stream: new requests are not reaching the queue."

  namespace   = "AWS/Lambda"
  metric_name = "IteratorAge"
  dimensions  = { FunctionName = module.enqueuer.name }
  statistic   = "Maximum"

  period              = 60
  evaluation_periods  = 1
  threshold           = 5 * 60 * 1000 # the metric is in milliseconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [module.alerts_topic.arn]
}
