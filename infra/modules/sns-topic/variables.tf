variable "name" {
  description = "Full topic name, e.g. aws-starter-dev-alerts."
  type        = string
}

variable "email" {
  description = "E-mail address to subscribe. null = create the topic without a subscription. Each subscription needs a confirmation click."
  type        = string
  default     = null
}

variable "filter_policy" {
  description = "Subscription filter on message attributes, e.g. { status = [\"failed\", \"rejected\"] } mails only messages whose attribute `status` has one of these values. null = every message is mailed. Ignored when there is no e-mail subscription."
  type        = map(list(string))
  default     = null
}

variable "allow_cloudwatch_alarms" {
  description = "Let CloudWatch alarms of this account publish to the topic (needed when the topic is an alarm action)."
  type        = bool
  default     = false
}
