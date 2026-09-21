output "api_url" {
  description = "Base URL of the API including the stage, without a trailing slash (paths such as /requests are appended to it)."
  value       = trimsuffix(aws_api_gateway_stage.this.invoke_url, "/")
}

output "api_id" {
  description = "API ID."
  value       = aws_api_gateway_rest_api.this.id
}

output "api_name" {
  description = "API name."
  value       = aws_api_gateway_rest_api.this.name
}

output "stage_name" {
  description = "Name of the stage the API is deployed to."
  value       = aws_api_gateway_stage.this.stage_name
}

output "access_log_group_name" {
  description = "CloudWatch log group of the access log."
  value       = aws_cloudwatch_log_group.access.name
}
