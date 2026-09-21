# Long-term archive of everything the application logs.
#
#   CloudWatch log groups --subscription filter--> Firehose --> S3 <-- Athena (athena.tf)
#
# CloudWatch Logs is the hot tier (recent lines, Logs Insights, a short retention); this module
# is the cold one: every line is copied to S3 within minutes and kept for var.expiration_days,
# and Athena queries it. The logger's guard keeps personal data out of the lines (docs/api.md,
# "Logs"), which is what makes a long archive acceptable.
#
# The archived envelope carries the AWS account id (the `owner` field), so the bucket stays
# private: no public access, no bucket policy, only IAM principals of this account read it.
#
# Cost at our volume (a few MB of logs a month) is cents. Firehose has no free tier: it bills
# per GB ingested, and rounds every record up to 5 KB; S3 and Athena are billed per GB stored
# and per TB scanned (both amounts are tiny here); the subscription filters, the Glue catalog
# (far below its free 1M objects) and the workgroup cost nothing by themselves.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id  = data.aws_caller_identity.current.account_id
  region      = data.aws_region.current.region
  stream_name = "${var.prefix}-log-archive"

  # The name and the stream Firehose's own console gives to its error log; the IAM policy
  # below is scoped to exactly this stream.
  firehose_log_group  = "/aws/kinesisfirehose/${local.stream_name}"
  firehose_log_stream = "DestinationDelivery"
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

# No versioning: Firehose gives every object a unique name and never overwrites one, so there
# is no earlier version to protect, and with versions the rules below would need a second set
# for the old ones.
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

  # Batches Firehose could not process or deliver hold the same lines as logs/, so they are
  # kept as long as the archive; a shorter rule would delete data that is still worth a look.
  rule {
    id     = "expire-firehose-errors"
    status = "Enabled"

    filter {
      prefix = "errors/"
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
# Firehose: receives the log batches from CloudWatch Logs and writes them to S3
# ---------------------------------------------------------------------------

# Firehose reports its own failures here; without it a delivery problem (say, a broken role)
# would be silent and the archive would just stay empty. The group is not subscribed to
# itself, so there is no loop.
resource "aws_cloudwatch_log_group" "firehose" {
  name              = local.firehose_log_group
  retention_in_days = 14
}

resource "aws_cloudwatch_log_stream" "firehose" {
  name           = local.firehose_log_stream
  log_group_name = aws_cloudwatch_log_group.firehose.name
}

resource "aws_kinesis_firehose_delivery_stream" "this" {
  name        = local.stream_name
  destination = "extended_s3" # the S3 destination that supports processors and a custom prefix

  extended_s3_configuration {
    role_arn   = aws_iam_role.firehose.arn
    bucket_arn = aws_s3_bucket.this.arn

    # Firehose flushes at 5 MB or 300 s, whichever comes first (the defaults, stated on
    # purpose). At our volume the 300 s always wins, so a line reaches S3 within about five
    # minutes and an object holds five minutes of lines from all the groups.
    buffering_size     = 5
    buffering_interval = 300

    # Gzip: JSON compresses about tenfold, which also cuts what Athena scans (it bills the
    # compressed bytes) and reads .gz objects without any setting.
    compression_format = "GZIP"

    # A timestamp prefix, not dynamic partitioning (that is billed per GB extra). The
    # timestamp is when Firehose wrote the object (UTC), not when the line was logged, so a
    # line logged just before midnight can sit in the next day's folder. The Hive-style
    # year=/month=/day= names are what the Glue table (athena.tf) projects.
    prefix = "logs/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/"

    # Required whenever the prefix has expressions; must contain the error type, which
    # separates failures of processing from failures of delivery.
    error_output_prefix = "errors/!{firehose:error-output-type}/"

    processing_configuration {
      enabled = true

      # CloudWatch Logs sends each record as one gzip-compressed batch. Decompression turns it
      # back into the JSON envelope: { messageType, owner, logGroup, logStream,
      # subscriptionFilters, logEvents: [ { id, timestamp, message } ] }.
      # The whole envelope is kept, so the CloudWatchLogProcessing processor (message
      # extraction, which drops the envelope) is NOT used: the log group and stream names are
      # what makes an archived line meaningful.
      processors {
        type = "Decompression"

        parameters {
          parameter_name  = "CompressionFormat"
          parameter_value = "GZIP"
        }
      }

      # Firehose concatenates records; a newline after each one makes the object JSON lines,
      # which is what Athena's JSON reader expects (one envelope per line). Without a
      # Delimiter parameter the delimiter is a newline. Order matters: after Decompression.
      processors {
        type = "AppendDelimiterToRecord"
      }
    }

    cloudwatch_logging_options {
      enabled         = true
      log_group_name  = aws_cloudwatch_log_group.firehose.name
      log_stream_name = aws_cloudwatch_log_stream.firehose.name
    }
  }

  # The stream is checked against its role when it is created; the role must already have
  # its permissions then.
  depends_on = [aws_iam_role_policy.firehose]
}

# ---------------------------------------------------------------------------
# IAM: Firehose writes to the bucket
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "firehose_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["firehose.amazonaws.com"]
    }

    # Confused-deputy guard in the form Firehose's documentation prescribes for its role:
    # only Firehose acting for this account can assume it.
    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "firehose" {
  name               = "${var.prefix}-log-archive-firehose" # starts with the project name: the CI deploy role may manage only those roles
  assume_role_policy = data.aws_iam_policy_document.firehose_assume.json
}

data "aws_iam_policy_document" "firehose" {
  # Bucket-level actions Firehose uses to find the bucket's region and to clean up an
  # interrupted upload. They take the bucket ARN, not object ARNs.
  statement {
    actions = [
      "s3:GetBucketLocation",
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
    ]
    resources = [aws_s3_bucket.this.arn]
  }

  # Writing, on the two prefixes Firehose writes to and nowhere else in the bucket.
  # AbortMultipartUpload is for uploads it starts itself and does not finish. No GetObject:
  # Firehose never reads back what it wrote.
  statement {
    actions   = ["s3:AbortMultipartUpload", "s3:PutObject"]
    resources = ["${aws_s3_bucket.this.arn}/logs/*", "${aws_s3_bucket.this.arn}/errors/*"]
  }

  # Its own error log, on its own stream only.
  statement {
    actions   = ["logs:PutLogEvents"]
    resources = [aws_cloudwatch_log_stream.firehose.arn]
  }
}

resource "aws_iam_role_policy" "firehose" {
  name   = "permissions"
  role   = aws_iam_role.firehose.id
  policy = data.aws_iam_policy_document.firehose.json
}

# ---------------------------------------------------------------------------
# IAM: CloudWatch Logs puts records into the stream
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "logs_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    # AWS's documentation shows the global name for this service principal in some places and
    # the regional one in others; listing both means neither form can break the pipeline.
    principals {
      type        = "Service"
      identifiers = ["logs.amazonaws.com", "logs.${local.region}.amazonaws.com"]
    }

    # Confused-deputy guard: CloudWatch Logs may use this role only on behalf of log groups
    # of this account in this region (the documented condition for a Firehose subscription).
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "StringLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:logs:${local.region}:${local.account_id}:*"]
    }
  }
}

resource "aws_iam_role" "logs_to_firehose" {
  name               = "${var.prefix}-log-archive-logs" # starts with the project name, see the Firehose role
  assume_role_policy = data.aws_iam_policy_document.logs_assume.json
}

data "aws_iam_policy_document" "logs_to_firehose" {
  # Only the two calls CloudWatch Logs makes, only on this stream.
  statement {
    actions   = ["firehose:PutRecord", "firehose:PutRecordBatch"]
    resources = [aws_kinesis_firehose_delivery_stream.this.arn]
  }
}

resource "aws_iam_role_policy" "logs_to_firehose" {
  name   = "permissions"
  role   = aws_iam_role.logs_to_firehose.id
  policy = data.aws_iam_policy_document.logs_to_firehose.json
}

# ---------------------------------------------------------------------------
# One subscription filter per log group
# ---------------------------------------------------------------------------

# An empty pattern matches every line, including the platform's START / END / REPORT lines
# (the REPORT line has the duration and memory of an invocation). A log group may have at
# most two subscription filters, so a second consumer is possible but not a third.
#
# On creation CloudWatch Logs sends a test message to the stream, so the filter needs the
# role to be assumable and permitted already; the test message is archived too, as a
# CONTROL_MESSAGE (the queries in athena.tf skip those). If the very first apply still
# fails with "Could not deliver test message", IAM had not propagated yet: apply again.
resource "aws_cloudwatch_log_subscription_filter" "this" {
  for_each = var.log_group_names

  name            = local.stream_name # the name only has to be unique within one log group
  log_group_name  = each.value
  filter_pattern  = ""
  destination_arn = aws_kinesis_firehose_delivery_stream.this.arn
  role_arn        = aws_iam_role.logs_to_firehose.arn

  depends_on = [aws_iam_role_policy.logs_to_firehose]
}
