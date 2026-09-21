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

# ---------------------------------------------------------------------------
# The recipient of the messages: another system, outside this stack (docs/api.md,
# "The recipient"; its HTTP contract is contracts/partner-api.md).
# ---------------------------------------------------------------------------

variable "partner_url" {
  description = "Base URL of the recipient: https://<host>[:<port>], with no trailing slash, path or query (the worker appends /v1/submissions). Not defaulted: set it in the git-ignored terraform.tfvars (in CI: TF_VAR_partner_url from the GitHub variable PARTNER_URL)."
  type        = string
  nullable    = false

  validation {
    # https only, because the API key travels in a header. A plain host name with an optional
    # port: no user:password@, path, query or fragment, so the worker's URL building cannot
    # go wrong.
    condition     = can(regex("^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?$", var.partner_url))
    error_message = "Expected https://<host>[:<port>] with no trailing slash, path or query, e.g. https://partner.example.com."
  }
}

variable "partner_api_key" {
  description = "The API key the recipient checks (header X-API-Key): a secret shared with it, stored in SSM Parameter Store. Ephemeral: Terraform never writes it to the state or to a plan file, so it has to be given again on every plan and every apply, best as TF_VAR_partner_api_key (in CI: the GitHub secret PARTNER_API_KEY). To rotate it, see partner_api_key_version."
  type        = string
  sensitive   = true
  ephemeral   = true
  nullable    = false

  validation {
    # A length check only. The message does not repeat the value.
    condition     = length(var.partner_api_key) >= 16
    error_message = "The API key must be at least 16 characters long."
  }
}

variable "partner_api_key_version" {
  description = "Version counter of partner_api_key. Terraform cannot compare a write-only value with what is stored, so it sends the key to SSM again only when this number changes. To rotate the key: give the new value AND raise this number by one (details at aws_ssm_parameter.partner_api_key in main.tf)."
  type        = number
  default     = 1
  nullable    = false
}

variable "sender_name" {
  description = "How this system names itself in the messages (Sender/Name in the XML). Letters, digits, space and . , ' & - only, 1 to 100 characters: the recipient's schema (PartyName in contracts/xsd/common-types.xsd) accepts nothing else."
  type        = string
  default     = "aws-starter"
  nullable    = false

  validation {
    # The same rule as the schema's PartyName pattern, written in Terraform's (RE2) regular
    # expressions: \p{L} = any letter, \p{N} = any digit-like character.
    condition     = can(regex("^[\\p{L}\\p{N} .,'&-]{1,100}$", var.sender_name))
    error_message = "Expected 1 to 100 characters: letters, digits, space and . , ' & - only."
  }
}

# ---------------------------------------------------------------------------
# The webhook the recipient calls (docs/api.md, "Client decision (webhook)"; its HTTP
# contract is contracts/webhook-api.md).
# ---------------------------------------------------------------------------

variable "webhook_token" {
  description = "The token the recipient signs its webhook calls with (the key of an HMAC-SHA256, contracts/webhook-api.md): a secret shared with it, stored in SSM Parameter Store. Ephemeral: Terraform never writes it to the state or to a plan file, so it has to be given again on every plan and every apply, best as TF_VAR_webhook_token (in CI: the GitHub secret PARTNER_WEBHOOK_TOKEN). To rotate it, see webhook_token_version."
  type        = string
  sensitive   = true
  ephemeral   = true
  nullable    = false

  validation {
    # A length check only. The message does not repeat the value.
    condition     = length(var.webhook_token) >= 16
    error_message = "The webhook token must be at least 16 characters long."
  }
}

variable "webhook_token_version" {
  description = "Version counter of webhook_token. Terraform cannot compare a write-only value with what is stored, so it sends the token to SSM again only when this number changes. To rotate the token: give the new value AND raise this number by one (the same recipe as partner_api_key_version, at aws_ssm_parameter.partner_api_key in main.tf)."
  type        = number
  default     = 1
  nullable    = false
}
