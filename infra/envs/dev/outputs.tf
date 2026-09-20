# The frontend build and CI read these (`terraform output -raw <name>`).

output "api_url" {
  description = "Base URL of the API, without a trailing slash."
  value       = module.api.api_url
}

output "cognito_user_pool_id" {
  description = "Cognito user pool ID."
  value       = module.cognito.user_pool_id
}

output "cognito_client_id" {
  description = "ID of the public web app client (not a secret)."
  value       = module.cognito.client_id
}

output "cognito_hosted_ui_url" {
  description = "Base URL of the Cognito hosted UI (login and logout pages)."
  value       = module.cognito.hosted_ui_url
}

# `one()` turns the empty list of a disabled static site into null.
output "site_url" {
  description = "https URL of the frontend; null when the static site is disabled."
  value       = one(local.site_origins)
}

output "site_bucket" {
  description = "Bucket the frontend build is uploaded to; null when the static site is disabled."
  value       = one(module.static_site[*].bucket_name)
}

output "distribution_id" {
  description = "CloudFront distribution ID (for cache invalidation after an upload); null when the static site is disabled."
  value       = one(module.static_site[*].distribution_id)
}

output "table_name" {
  description = "DynamoDB table name."
  value       = module.requests_table.name
}

output "queue_url" {
  description = "URL of the deliveries FIFO queue."
  value       = module.deliveries_queue.url
}

output "dlq_url" {
  description = "URL of the deliveries dead-letter queue (messages that ran out of attempts, for inspection)."
  value       = module.deliveries_queue.dlq_url
}

# Not a secret, but not open either: the Function URL uses auth type AWS_IAM, so a request
# is served only if it is signed (SigV4) by a principal allowed lambda:InvokeFunctionUrl on
# partner-mock. This stack grants that permission to the delivery-worker's role only.
output "partner_url" {
  description = "Function URL of partner-mock. Not secret, but IAM-protected: unsigned requests are refused."
  value       = module.partner_mock.function_url
}

output "audit_bucket" {
  description = "Bucket that holds the audit copies of delivered requests (they expire automatically)."
  value       = module.audit_bucket.name
}

output "region" {
  description = "AWS region of the stack."
  value       = var.region
}
