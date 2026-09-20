variable "name" {
  description = "API name, e.g. aws-starter-dev-api."
  type        = string
}

variable "allowed_origins" {
  description = "Browser origins allowed by CORS (scheme + host, no trailing slash)."
  type        = list(string)
}

variable "jwt_issuer" {
  description = "Issuer of the tokens the API accepts, e.g. https://cognito-idp.<region>.amazonaws.com/<pool id>."
  type        = string
}

variable "jwt_audience" {
  description = "Client IDs the API accepts tokens for."
  type        = list(string)
}

variable "routes" {
  description = "One entry per Lambda-backed route. Every route requires a valid JWT."
  type = map(object({
    route_key     = string # e.g. "GET /requests/{id}"
    function_name = string
    invoke_arn    = string
  }))
}

variable "log_retention_days" {
  description = "How long CloudWatch keeps the access logs."
  type        = number
  default     = 14
}
