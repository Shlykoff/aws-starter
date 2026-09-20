variable "region" {
  description = "AWS region for everything in this project."
  type        = string
  default     = "eu-north-1"
}

variable "project" {
  description = "Short project name, used as a prefix in resource names."
  type        = string
  default     = "aws-starter"
}

variable "github_repo" {
  description = "GitHub repository allowed to deploy, as owner/name."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repo))
    error_message = "Use the owner/name format, e.g. my-user/serverless-starter."
  }
}

variable "alert_email" {
  description = "Where budget alerts are sent."
  type        = string
}

variable "monthly_budget_usd" {
  description = "Monthly cost limit for the whole AWS account. Alerts at 80% actual and 100% forecast."
  type        = number
  default     = 5
}
