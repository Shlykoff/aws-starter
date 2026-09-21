variable "name_prefix" {
  description = "Prefix of every resource name, e.g. aws-starter-dev."
  type        = string
}

variable "namespace" {
  description = "CloudWatch namespace of the custom metrics, e.g. aws-starter/dev. The delivery-worker writes its two latency metrics into the same namespace (METRICS_NAMESPACE)."
  type        = string
}

variable "alarm_topic_arn" {
  description = "SNS topic that every alarm of this module notifies."
  type        = string
}

variable "lambda_log_group_names" {
  description = "Log group of every Lambda function of the project, by short function name. Each gets a log-guard metric filter, and the saved queries read them all."
  type        = map(string)
}

variable "worker_function_name" {
  description = "Name of the delivery-worker function (dimension of its Lambda metrics)."
  type        = string
}

variable "worker_log_group_name" {
  description = "Log group of the delivery-worker: the delivery metrics are counted in it."
  type        = string
}

variable "worker_timeout_seconds" {
  description = "Timeout of the delivery-worker. The duration alarm fires at 80 % of it."
  type        = number
}

variable "webhook_function_name" {
  description = "Name of the receive-webhook function (dimension of its Lambda metrics)."
  type        = string
}

variable "webhook_log_group_name" {
  description = "Log group of receive-webhook: unauthorized calls are counted in it."
  type        = string
}

variable "archiver_function_name" {
  description = "Name of the log archiver function (dimension of its Lambda metrics, shown on the dashboard)."
  type        = string
}

variable "api_id" {
  description = "ID of the HTTP API (dimension of its metrics)."
  type        = string
}

variable "queue_name" {
  description = "Name of the deliveries queue, including .fifo (dimension of its metrics)."
  type        = string
}

variable "dlq_name" {
  description = "Name of the deliveries dead-letter queue, including .fifo (dimension of its metrics)."
  type        = string
}

variable "table_name" {
  description = "Name of the requests table (dimension of its metrics)."
  type        = string
}

variable "other_alarm_arns" {
  description = "Alarms of the project that are defined elsewhere. They only appear in the dashboard's alarm widget; this module's own alarms are added to it."
  type        = list(string)
  default     = []
}
