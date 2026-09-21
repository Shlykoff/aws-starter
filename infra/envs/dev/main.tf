locals {
  prefix = "${var.project}-${var.env}" # every resource name is <project>-<env>-<thing>

  # One entry per API function; the routes are the ones in docs/api.md. Every function gets
  # TABLE_NAME and exactly one DynamoDB action, the one its handler needs. An entry may add
  # `environment` and `policy_statements` of its own (only get-exchange does); the module
  # block below treats a missing one as "none". One loop, not a second module block, so that
  # the routes, environments and permissions of all API functions stay in this one map.
  functions = {
    create-request = { route_key = "POST /requests", dynamodb_action = "dynamodb:PutItem" }
    list-requests  = { route_key = "GET /requests", dynamodb_action = "dynamodb:Query" }
    get-request    = { route_key = "GET /requests/{id}", dynamodb_action = "dynamodb:GetItem" }

    # Returns the exchange record (the XML sent and the reply) of a request. The record is in
    # S3; the table is read only to check that the request belongs to the caller.
    get-exchange = {
      route_key       = "GET /requests/{id}/exchange"
      dynamodb_action = "dynamodb:GetItem"
      environment     = { AUDIT_BUCKET = module.audit_bucket.name }
      policy_statements = [
        {
          actions   = ["s3:GetObject"] # only the exchange records, nothing else in the bucket
          resources = ["${module.audit_bucket.arn}/exchanges/*"]
        },
        {
          # Without s3:ListBucket, S3 answers a missing key with 403 instead of 404, and the
          # handler could not tell "no exchange yet" (404) from broken permissions (500).
          # No `s3:prefix` condition on purpose: S3 decides 404 or 403 for a GetObject on a
          # missing key by asking whether the caller may list the bucket, and a GetObject
          # request carries no prefix, so a prefix condition could never match and the answer
          # would stay 403. What listing adds is small: the bucket holds nothing but exchange
          # records, this function can already read every one of them, and the ownership check
          # is in the code, not in a key name.
          actions   = ["s3:ListBucket"]
          resources = [module.audit_bucket.arn] # this action takes the bucket, not its objects
        },
      ]
    }
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

  environment = merge(
    local.common_environment,
    { TABLE_NAME = module.requests_table.name },
    lookup(each.value, "environment", {}),
  )

  policy_statements = concat(
    [{
      actions   = [each.value.dynamodb_action]
      resources = [module.requests_table.arn]
    }],
    lookup(each.value, "policy_statements", []),
  )
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
#   table stream -> enqueuer -> SQS FIFO -> delivery-worker -> HTTPS + API key -> the recipient
# The recipient is another system, outside this stack: this file knows its base URL and its API
# key only. Around the flow: an exchange record in S3 (the XML sent and the reply, read back by
# get-exchange above), SNS notices and two alarms.
# ---------------------------------------------------------------------------

locals {
  # Numbers that must agree with each other are defined once, here.
  worker_timeout_seconds = 15 # timeout of the delivery-worker (docs/api.md)

  # The queue refuses to be created if this is below 6 x worker_timeout_seconds.
  delivery_visibility_timeout_seconds = 120

  # Receives after which SQS moves a message to the DLQ. The worker gets the same number as
  # MAX_RECEIVE_COUNT, so it knows which attempt is the last one.
  delivery_max_receive_count = 5

  # Set on every function (docs/api.md, "Lambda contract").
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

# Holds the exchange records. The module keeps its first name (see the module).
module "audit_bucket" {
  source = "../../modules/audit-bucket"

  name = "${local.prefix}-deliveries"
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

# The API key the recipient checks (docs/api.md, "The recipient"); the worker reads it at run
# time, so it is in no environment variable and no code.
#
# SecureString on the default AWS-managed key alias/aws/ssm (a customer-managed key would cost
# a monthly fee); Standard tier, which is free (Advanced is billed per parameter, and when no
# tier is given the account's default tier applies).
#
# value_wo is a WRITE-ONLY argument: Terraform sends it to AWS and never stores it, not in the
# state and not in a plan file (var.partner_api_key is ephemeral for the same reason). The
# price: Terraform cannot tell that the value changed, so it sends it again only when
# value_wo_version changes.
#
# To rotate the key:
#   1. agree the new key with the recipient;
#   2. give Terraform the new value (TF_VAR_partner_api_key, in CI the GitHub secret);
#   3. raise partner_api_key_version by one (terraform.tfvars, or the variable in CI);
#   4. apply.
# Changing only the value does nothing, silently: the plan shows no change. The worker uses the
# new key once its 5-minute cache runs out or a new instance starts. A wrong key is answered
# with 401, which the worker retries.
resource "aws_ssm_parameter" "partner_api_key" {
  # SSM names are paths, not <project>-<env>-<thing>. The environment comes first because SSM
  # refuses any name that starts with "aws" or "ssm" (reserved for AWS itself), and the
  # project is called aws-starter: /aws-starter/dev/... failed with "No access to reserved
  # parameter name".
  name = "/${var.env}/${var.project}/partner-api-key"

  type             = "SecureString"
  tier             = "Standard"
  value_wo         = var.partner_api_key
  value_wo_version = var.partner_api_key_version
}

module "delivery_worker" {
  source = "../../modules/lambda-function"

  name       = "${local.prefix}-delivery-worker"
  source_dir = "${var.backend_dist_dir}/delivery-worker"
  timeout    = local.worker_timeout_seconds

  environment = merge(local.common_environment, {
    TABLE_NAME            = module.requests_table.name
    PARTNER_URL           = var.partner_url
    PARTNER_API_KEY_PARAM = aws_ssm_parameter.partner_api_key.name # the name only, never the key
    SENDER_NAME           = var.sender_name
    TOPIC_ARN             = module.request_status_topic.arn
    AUDIT_BUCKET          = module.audit_bucket.name
    MAX_RECEIVE_COUNT     = tostring(local.delivery_max_receive_count) # environment variables are strings
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
      actions   = ["s3:PutObject"] # only the exchange records, nothing else in the bucket
      resources = ["${module.audit_bucket.arn}/exchanges/*"]
    },
    {
      # Reads the API key. It is a SecureString on the AWS-managed key alias/aws/ssm, and that
      # key needs no kms:Decrypt statement here: its key policy lets every principal of the
      # account use it through SSM (Sid "Allow access through SSM for all principals in the
      # account that are authorized to use SSM", conditions kms:CallerAccount and
      # kms:ViaService = ssm.<region>.amazonaws.com); the SSM docs add that access control
      # policies cannot be set for the default aws/ssm key.
      actions   = ["ssm:GetParameter"]
      resources = [aws_ssm_parameter.partner_api_key.arn]
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
