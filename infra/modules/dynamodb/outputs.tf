output "name" {
  description = "Table name (goes into the TABLE_NAME environment variable of the functions)."
  value       = aws_dynamodb_table.this.name
}

output "arn" {
  description = "Table ARN, used to scope the functions' IAM statements."
  value       = aws_dynamodb_table.this.arn
}
