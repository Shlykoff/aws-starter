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

variable "github_oidc_subject_prefix" {
  description = "Start of the `sub` claim in the tokens GitHub Actions issues for the repository that may deploy. Newer repositories use immutable IDs (repo:OWNER@OWNER_ID/REPO@REPO_ID), older ones repo:OWNER/REPO. Print it with: gh api repos/OWNER/REPO/actions/oidc/customization/sub --jq .sub_claim_prefix"
  type        = string

  validation {
    condition     = can(regex("^repo:[A-Za-z0-9-]+(@[0-9]+)?/[A-Za-z0-9._-]+(@[0-9]+)?$", var.github_oidc_subject_prefix))
    error_message = "Expected repo:OWNER@ID/REPO@ID or repo:OWNER/REPO, as printed by the gh command in the description."
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
