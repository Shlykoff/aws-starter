output "bucket_name" {
  description = "Bucket the frontend build is uploaded to."
  value       = aws_s3_bucket.site.id
}

output "distribution_id" {
  description = "CloudFront distribution ID (needed to invalidate the cache after an upload)."
  value       = aws_cloudfront_distribution.site.id
}

output "domain_name" {
  description = "CloudFront domain, e.g. d111111abcdef8.cloudfront.net (no scheme)."
  value       = aws_cloudfront_distribution.site.domain_name
}
