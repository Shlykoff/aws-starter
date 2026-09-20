variable "project" {
  description = "Short project name, used as a prefix in resource names."
  type        = string
  default     = "aws-starter"
}

variable "env" {
  description = "Environment name, used in resource names and tags."
  type        = string
  default     = "dev"
}

variable "region" {
  description = "AWS region for everything in this stack. Must match the region in backend.tf."
  type        = string
  default     = "eu-north-1"
}

variable "backend_dist_dir" {
  description = "Backend build output: one sub-directory per function, each with an index.mjs. Relative to this directory, or absolute."
  type        = string
  default     = "../../../backend/dist" # <repo>/backend/dist
}

variable "cognito_domain_prefix" {
  description = "Prefix of the Cognito hosted UI domain (https://<prefix>.auth.<region>.amazoncognito.com). Globally unique per region, so it is not defaulted: set it in the git-ignored terraform.tfvars. No \"aws\", \"amazon\" or \"cognito\" in it."
  type        = string
}

variable "notification_email" {
  description = "Where the SNS topics send mail: notices about failed or rejected requests, and operational alarms. Each of the two subscriptions sends a confirmation mail whose link must be clicked. Not defaulted: set it in the git-ignored terraform.tfvars (in CI: TF_VAR_notification_email from a secret)."
  type        = string

  validation {
    # A basic shape check (something@something.tld); the real test is the confirmation mail.
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.notification_email))
    error_message = "Expected an e-mail address such as name@example.com."
  }
}

variable "enable_static_site" {
  description = "Create the S3 bucket and CloudFront distribution for the frontend. Turn off if CloudFront is not available on the account."
  type        = bool
  default     = true
}
