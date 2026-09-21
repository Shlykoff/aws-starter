output "name" {
  description = "Function name."
  value       = aws_lambda_function.this.function_name
}

output "arn" {
  description = "Function ARN."
  value       = aws_lambda_function.this.arn
}

output "invoke_arn" {
  description = "ARN API Gateway uses to invoke the function."
  value       = aws_lambda_function.this.invoke_arn
}

output "role_arn" {
  description = "ARN of the function's execution role."
  value       = aws_iam_role.this.arn
}

output "log_group_name" {
  description = "CloudWatch log group of the function."
  value       = aws_cloudwatch_log_group.this.name
}
