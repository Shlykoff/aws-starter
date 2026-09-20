output "user_pool_id" {
  description = "User pool ID."
  value       = aws_cognito_user_pool.this.id
}

output "client_id" {
  description = "ID of the public web app client."
  value       = aws_cognito_user_pool_client.web.id
}

output "issuer" {
  description = "Token issuer (iss claim); the API Gateway JWT authorizer checks it."
  value       = "https://${aws_cognito_user_pool.this.endpoint}" # endpoint is cognito-idp.<region>.amazonaws.com/<pool id>
}

output "hosted_ui_url" {
  description = "Base URL of the hosted UI."
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.region}.amazoncognito.com"
}
