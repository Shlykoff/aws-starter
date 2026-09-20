variable "name_prefix" {
  description = "Prefix for the pool and client names, e.g. aws-starter-dev (gives aws-starter-dev-users and aws-starter-dev-web)."
  type        = string
}

variable "domain_prefix" {
  description = "Hosted UI domain prefix. Must be unique across all AWS accounts in the region and must not contain the reserved words aws, amazon or cognito."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", var.domain_prefix)) && length(var.domain_prefix) <= 63 && !can(regex("aws|amazon|cognito", var.domain_prefix))
    error_message = "Use 1-63 lowercase letters, digits and hyphens (not at the ends), and none of the words aws, amazon, cognito."
  }
}

variable "web_origins" {
  description = "Origins of the web app (scheme + host, no trailing slash), e.g. http://localhost:5173. Login callback and logout URLs are built from them."
  type        = list(string)
}
