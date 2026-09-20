data "aws_caller_identity" "current" {}

# Managed policy "CachingOptimized": caches by path only, ignores cookies and query strings,
# and lets CloudFront compress. Looked up by name instead of pasting its opaque ID.
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

# Bucket names are global; the account ID suffix avoids collisions (same trick as the
# state bucket in bootstrap/). It comes from a data source, so it is never in the code.
resource "aws_s3_bucket" "site" {
  bucket = "${var.name}-${data.aws_caller_identity.current.account_id}"

  # The content is rebuilt from the frontend on every deploy, and `terraform destroy`
  # must work even when the bucket is not empty.
  force_destroy = true
}

# The bucket is private: only CloudFront may read it (bucket policy below).
resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256" # SSE-S3: free, and CloudFront needs no KMS permissions to read it
    }
  }
}

# Origin Access Control: CloudFront signs its requests to S3 (SigV4), so the bucket can
# stay private. It replaces the older Origin Access Identity.
resource "aws_cloudfront_origin_access_control" "site" {
  name                              = var.name
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100" # edge locations in North America and Europe only: the cheapest class

  origin {
    origin_id                = "site-bucket"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name # the regional name avoids S3 redirects right after creation
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id       = "site-bucket"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    viewer_protocol_policy = "redirect-to-https"
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id
  }

  # Single-page app routing: /requests/123 is not a file in the bucket, the React router
  # handles it. S3 answers 403 (not 404) for a missing key when the caller has no
  # s3:ListBucket, so both codes serve index.html.
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # The default *.cloudfront.net certificate: a custom domain would need Route 53 and ACM.
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# Only this distribution may read objects. Without the SourceArn condition every
# CloudFront distribution in every account could read the bucket through OAC.
data "aws_iam_policy_document" "site" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = data.aws_iam_policy_document.site.json

  # The policy must not race the public access block (both change bucket-level settings).
  depends_on = [aws_s3_bucket_public_access_block.site]
}
