# A FIFO queue with its dead-letter queue. A FIFO queue may only use a FIFO DLQ, so both
# names end in ".fifo".

# Messages that ran out of attempts land here and stay for inspection (the retention is
# the longest SQS allows). Nothing reads this queue automatically.
resource "aws_sqs_queue" "dlq" {
  name       = "${var.name}-dlq.fifo"
  fifo_queue = true

  message_retention_seconds = var.dlq_retention_days * 24 * 60 * 60
  sqs_managed_sse_enabled   = true # SSE-SQS: encrypted at rest with SQS-owned keys, so producers and consumers need no KMS permissions
}

resource "aws_sqs_queue" "this" {
  name       = "${var.name}.fifo"
  fifo_queue = true

  # Off on purpose: the producer sets MessageDeduplicationId itself (the request id), so two
  # different requests with the same text are never mistaken for duplicates.
  content_based_deduplication = false

  visibility_timeout_seconds = var.visibility_timeout_seconds
  message_retention_seconds  = var.retention_days * 24 * 60 * 60
  sqs_managed_sse_enabled    = true

  # After max_receive_count receives without a delete, SQS moves the message to the DLQ.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  lifecycle {
    # AWS guidance for a Lambda consumer: while one attempt runs (or is throttled and
    # retried), the message must stay invisible. A queue that breaks this rule would hand
    # the same message to a second worker while the first is still busy.
    precondition {
      condition     = var.visibility_timeout_seconds >= 6 * var.consumer_timeout_seconds
      error_message = "visibility_timeout_seconds (${var.visibility_timeout_seconds}) must be at least 6 x the consumer timeout (${var.consumer_timeout_seconds} s)."
    }
  }
}
