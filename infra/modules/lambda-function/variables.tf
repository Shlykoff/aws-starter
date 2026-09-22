variable "name" {
  description = "Full function name, e.g. aws-starter-dev-create-request. Also used for the IAM role and the log group."
  type        = string
}

variable "source_dir" {
  description = "Directory with the built code (index.mjs and friends); zipped by Terraform."
  type        = string
}

variable "environment" {
  description = "Environment variables of the function."
  type        = map(string)
  default     = {}
}

variable "policy_statements" {
  description = "IAM statements besides logging. Every statement must name concrete actions and resource ARNs."
  type = list(object({
    actions   = list(string)
    resources = list(string)
  }))
  default = []

  validation {
    condition     = alltrue([for s in var.policy_statements : !anytrue([for r in s.resources : r == "*"])])
    error_message = "Wildcard resources are not allowed: scope each statement to concrete ARNs."
  }
}

variable "layers" {
  description = "ARNs of Lambda layers to attach (the OpenTelemetry layer of the traced functions)."
  type        = list(string)
  default     = []
}

variable "tracing" {
  description = "Turn on X-Ray active tracing: Lambda then records a trace (start-up time, run time, errors) for the invocations X-Ray samples. Off for the functions the browser polls: see .claude/DECISIONS.md."
  type        = bool
  default     = false
}

variable "needs_cognito_get_user" {
  description = "Grant cognito-idp:GetUser (reads the caller's own attributes with their access token). Like the X-Ray actions below, GetUser takes no UserPoolId or ARN of its own to scope a policy to, so it cannot go through policy_statements, which refuses \"*\"."
  type        = bool
  default     = false
}

variable "timeout" {
  description = "Timeout in seconds."
  type        = number
  default     = 10
}

variable "memory_size" {
  description = "Memory in MB."
  type        = number
  default     = 256
}

variable "log_retention_days" {
  description = "How long CloudWatch keeps the function logs."
  type        = number
  default     = 30 # long enough to look back over a month of requests; storage beyond the free 5 GB is billed per GB-month
}
