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

output "region" {
  description = "AWS region of the stack."
  value       = var.region
}
