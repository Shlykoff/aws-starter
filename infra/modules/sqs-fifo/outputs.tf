output "arn" {
  description = "Queue ARN (event source of the consumer, resource of the IAM statements)."
  value       = aws_sqs_queue.this.arn
}

output "url" {
  description = "Queue URL (goes into the producer's QUEUE_URL environment variable)."
  value       = aws_sqs_queue.this.url
}

output "name" {
  description = "Queue name including the .fifo suffix (the QueueName dimension of its CloudWatch metrics)."
  value       = aws_sqs_queue.this.name
}

output "dlq_arn" {
  description = "Dead-letter queue ARN."
  value       = aws_sqs_queue.dlq.arn
}

output "dlq_url" {
  description = "Dead-letter queue URL."
  value       = aws_sqs_queue.dlq.url
}

output "dlq_name" {
  description = "Dead-letter queue name including the .fifo suffix (the QueueName dimension of its CloudWatch metrics)."
  value       = aws_sqs_queue.dlq.name
}
