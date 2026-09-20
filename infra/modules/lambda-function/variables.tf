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
  description = "IAM statements besides logging. Every statement must name concrete actions and resource ARNs; conditions are optional."
  type = list(object({
    actions   = list(string)
    resources = list(string)
    conditions = optional(list(object({
      test     = string       # e.g. "StringEquals", "Bool"
      variable = string       # condition key, e.g. "lambda:FunctionUrlAuthType"
      values   = list(string) # a match on any of them is enough
    })), [])
  }))
  default = []

  validation {
    condition     = alltrue([for s in var.policy_statements : !anytrue([for r in s.resources : r == "*"])])
    error_message = "Wildcard resources are not allowed: scope each statement to concrete ARNs."
  }
}

variable "enable_function_url" {
  description = "Give the function an HTTPS URL. Always with auth type AWS_IAM: a caller must sign the request (SigV4) and be allowed lambda:InvokeFunctionUrl. A public URL (auth type NONE) is deliberately not offered by this module."
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
  default     = 14
}
