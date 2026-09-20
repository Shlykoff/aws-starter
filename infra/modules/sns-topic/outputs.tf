output "arn" {
  description = "Topic ARN (TOPIC_ARN of a publisher, resource of its sns:Publish statement, alarm action)."
  value       = aws_sns_topic.this.arn
}

output "name" {
  description = "Topic name."
  value       = aws_sns_topic.this.name
}
