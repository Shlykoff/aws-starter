output "name" {
  description = "Bucket name (goes into the AUDIT_BUCKET environment variable of the functions that read or write records)."
  value       = aws_s3_bucket.this.id
}

output "arn" {
  description = "Bucket ARN, used to scope IAM statements: append /<prefix>/* for object actions; s3:ListBucket takes the bucket ARN itself."
  value       = aws_s3_bucket.this.arn
}
