# Long-term archive of everything the application logs.
#
#   CloudWatch log groups --subscription filter--> archiver Lambda --> S3 <-- Athena (athena.tf)
#
# CloudWatch Logs is the hot tier (recent lines, Logs Insights, a short retention); this module
# is the cold one: every batch of lines is copied to S3 within seconds and kept for
# var.expiration_days, and Athena queries it. The logger's guard keeps personal data out of the
# lines (docs/api.md, "Logs"), which is what makes a long archive acceptable.
#
# The archived envelope carries the AWS account id (the `owner` field), so the bucket stays
# private: no public access, no bucket policy, only IAM principals of this account read it.
#
# Why a Lambda and not Firehose, the usual way: Firehose has no free tier, and the AWS "free"
# account plan this project runs on refuses it outright (SubscriptionRequiredException). The
# Lambda is a small function of our own (backend/src/services/log-archive-service.ts); its
# invocations, like everything else here, fall inside the always-free Lambda allowance.
#
# Cost at our volume (a few MB of logs a month): cents. Each batch is one Lambda invocation and
# one or two S3 PUT requests; S3 and Athena are billed per GB stored and per TB scanned (both
# amounts are tiny here); the subscription filters, the Glue catalog (far below its free 1M
# objects) and the workgroup cost nothing by themselves.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  # The name only has to be unique within one log group.
  filter_name = "${var.prefix}-log-archive"
}

# ---------------------------------------------------------------------------
# The bucket
# ---------------------------------------------------------------------------

# Bucket names are global; the account ID suffix avoids collisions (same trick as the audit
# bucket). It comes from a data source, so it is never in the code.
resource "aws_s3_bucket" "this" {
  bucket = "${var.prefix}-log-archive-${local.account_id}"

  # `terraform destroy` must work even when the archive is not empty (same as the audit bucket).
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256" # SSE-S3: no KMS key to manage or pay for
    }
  }
}

# No versioning: an object is named after the hash of its content, so writing it again (a retried
# invocation) replaces it with identical bytes, and there is no earlier version to protect. With
# versions the rules below would need a second set for the old ones.
#
# No transition to Standard-IA or Glacier on purpose: Standard-IA bills at least 128 KB per
# object and our objects are a few KB to a few tens of KB, so it would cost more, not less.
# At this volume Standard is already cents.
resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "expire-logs"
    status = "Enabled"

    filter {
      prefix = "logs/"
    }

    expiration {
      days = var.expiration_days
    }
  }

  # Query results are throw-away: rerunning a query is cheaper than keeping its output.
  rule {
    id     = "expire-athena-results"
    status = "Enabled"

    filter {
      prefix = "athena-results/"
    }

    expiration {
      days = 7
    }
  }

  # A multipart upload that never completed (a failed Athena result, say) is invisible in a
  # listing but is billed until it is aborted.
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# ---------------------------------------------------------------------------
# The archiver: receives the log batches from CloudWatch Logs and writes them to S3
# ---------------------------------------------------------------------------

module "archiver" {
  source = "../lambda-function"

  name       = "${var.prefix}-log-archiver"
  source_dir = var.archiver_source_dir

  environment = merge(var.environment, {
    ARCHIVE_BUCKET = aws_s3_bucket.this.id
  })

  policy_statements = [
    {
      # Writing under logs/ and nowhere else in the bucket. No read, no delete: the function
      # never looks at what it wrote, and the lifecycle rules do the deleting.
      actions   = ["s3:PutObject"]
      resources = ["${aws_s3_bucket.this.arn}/logs/*"]
    },
  ]
}

# ---------------------------------------------------------------------------
# One subscription filter per log group
# ---------------------------------------------------------------------------

# CloudWatch Logs may invoke the archiver only for the log group named here: without this the
# function would refuse the call, and one permission per group (not one for all groups) keeps
# the resource policy of the function as narrow as the archive itself. `:*` is the form of the
# ARN the service uses as the source of an invocation.
resource "aws_lambda_permission" "logs" {
  for_each = var.log_group_names

  statement_id   = "logs-${each.key}"
  action         = "lambda:InvokeFunction"
  function_name  = module.archiver.name
  principal      = "logs.amazonaws.com"
  source_arn     = "arn:aws:logs:${local.region}:${local.account_id}:log-group:${each.value}:*"
  source_account = local.account_id
}

# An empty pattern matches every line, including the platform's START / END / REPORT lines
# (the REPORT line has the duration and memory of an invocation). A log group may have at
# most two subscription filters, so a second consumer is possible but not a third.
#
# CloudWatch Logs invokes the archiver asynchronously, and Lambda itself retries a failed
# asynchronous invocation twice, so a short S3 outage does not lose a batch. A batch that
# fails all three times is dropped: the archive is a copy, the lines are still in CloudWatch
# Logs (docs/api.md, "Log archive").
resource "aws_cloudwatch_log_subscription_filter" "this" {
  for_each = var.log_group_names

  name            = local.filter_name
  log_group_name  = each.value
  filter_pattern  = ""
  destination_arn = module.archiver.arn

  lifecycle {
    # The archiver writes its own log lines. Subscribed to its own group it would archive
    # them, which is more lines, which is another invocation, without end.
    precondition {
      condition     = each.value != module.archiver.log_group_name
      error_message = "The log group of the archiver itself must not be archived: every run would trigger the next one."
    }
  }

  depends_on = [aws_lambda_permission.logs]
}
