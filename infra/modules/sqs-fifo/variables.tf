variable "name" {
  description = "Base name, e.g. aws-starter-dev-deliveries. The queue is named <name>.fifo and its dead-letter queue <name>-dlq.fifo."
  type        = string
}

variable "visibility_timeout_seconds" {
  description = "How long a received message stays hidden from other consumers. No default: choose it together with the consumer's timeout."
  type        = number
}

variable "consumer_timeout_seconds" {
  description = "Timeout of the function that reads the queue. Used only for a check: the visibility timeout must be at least 6 times this."
  type        = number
}

variable "max_receive_count" {
  description = "Receives after which SQS moves a message to the dead-letter queue. No default: the consumer needs the same number to know which attempt is the last."
  type        = number
}

variable "retention_days" {
  description = "How long the queue keeps a message that is not deleted."
  type        = number
  default     = 4
}

variable "dlq_retention_days" {
  description = "How long the dead-letter queue keeps a message (14 is the maximum SQS allows)."
  type        = number
  default     = 14
}
