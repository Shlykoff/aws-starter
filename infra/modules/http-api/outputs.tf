output "api_url" {
  description = "Base URL of the API, without a trailing slash (paths such as /requests are appended to it)."
  value       = trimsuffix(aws_apigatewayv2_stage.default.invoke_url, "/")
}

output "api_id" {
  description = "API ID."
  value       = aws_apigatewayv2_api.this.id
}
