output "name" {
  description = "Table name (goes into the TABLE_NAME environment variable of the functions)."
  value       = aws_dynamodb_table.this.name
}

output "arn" {
  description = "Table ARN, used to scope the functions' IAM statements."
  value       = aws_dynamodb_table.this.arn
}

output "stream_arn" {
  description = "ARN of the table's change stream: the event source of the enqueuer and the resource of its stream-read permissions."
  value       = aws_dynamodb_table.this.stream_arn
}
