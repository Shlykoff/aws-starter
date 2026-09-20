output "name" {
  description = "Bucket name (goes into the AUDIT_BUCKET environment variable of the writer)."
  value       = aws_s3_bucket.this.id
}

output "arn" {
  description = "Bucket ARN, used to scope the writer's IAM statement (append /<prefix>/*)."
  value       = aws_s3_bucket.this.arn
}
