output "api_url" {
  description = "Base URL of the API, without a trailing slash (paths such as /requests are appended to it)."
  value       = trimsuffix(aws_apigatewayv2_stage.default.invoke_url, "/")
}

output "api_id" {
  description = "API ID."
  value       = aws_apigatewayv2_api.this.id
}

output "access_log_group_name" {
  description = "CloudWatch log group of the access log."
  value       = aws_cloudwatch_log_group.access.name
}
