# The frontend build and CI read these (`terraform output -raw <name>`).

output "api_url" {
  description = "Base URL of the API, without a trailing slash."
  value       = module.api.api_url
}

output "webhook_url" {
  description = "Public address of the webhook (POST, signed): the recipient's WEBHOOK_URL. Give it to the recipient together with the webhook token."
  value       = "${module.api.api_url}${local.webhook_path}"
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

output "audit_bucket" {
  description = "Bucket that holds the exchange records (the XML sent and the reply, per request); they expire automatically."
  value       = module.audit_bucket.name
}

output "region" {
  description = "AWS region of the stack."
  value       = var.region
}
