output "name" {
  description = "Table name (goes into the TABLE_NAME environment variable of the functions)."
  value       = aws_dynamodb_table.this.name
}

output "arn" {
  description = "Table ARN, used to scope the functions' IAM statements."
  value       = aws_dynamodb_table.this.arn
}

output "by_request_id_index_arn" {
  description = "ARN of the by-request-id index, the resource of the webhook's dynamodb:Query permission (a Query on an index is authorized on the index ARN, not on the table ARN)."
  value       = "${aws_dynamodb_table.this.arn}/index/${local.by_request_id_index}"
}

output "stream_arn" {
  description = "ARN of the table's change stream: the event source of the enqueuer and the resource of its stream-read permissions."
  value       = aws_dynamodb_table.this.stream_arn
}
