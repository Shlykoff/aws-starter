data "aws_caller_identity" "current" {}

# Bucket names are global; the account ID suffix avoids collisions (same trick as the state
# bucket in bootstrap/ and the site bucket). It comes from a data source, so it is never in
# the code.
resource "aws_s3_bucket" "this" {
  bucket = "${var.name}-${data.aws_caller_identity.current.account_id}"

  # The objects are short-lived copies, and `terraform destroy` must work even when the
  # bucket is not empty.
  force_destroy = true
}

# Private: nothing but the function that writes the copies has access (through its IAM
# policy), so there is no bucket policy at all.
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

# Versioning stays off: a retried delivery overwrites the copy under the same key, and with
# versions the lifecycle rule below would also need a rule for the old ones.
resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "expire-audit-copies"
    status = "Enabled"

    filter {} # the whole bucket

    expiration {
      days = var.expiration_days
    }
  }
}
