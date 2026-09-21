output "user_pool_id" {
  description = "User pool ID."
  value       = aws_cognito_user_pool.this.id
}

output "client_id" {
  description = "ID of the public web app client."
  value       = aws_cognito_user_pool_client.web.id
}

output "user_pool_arn" {
  description = "User pool ARN; the API Gateway Cognito authorizer takes the pool by ARN."
  value       = aws_cognito_user_pool.this.arn
}

output "hosted_ui_url" {
  description = "Base URL of the hosted UI."
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.region}.amazoncognito.com"
}
