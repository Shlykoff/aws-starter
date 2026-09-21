variable "name" {
  description = "API name, e.g. aws-starter-dev-api. Also the prefix of the IAM role that lets API Gateway write access logs."
  type        = string
}

variable "cognito_user_pool_arn" {
  description = "ARN of the Cognito user pool whose tokens the API accepts."
  type        = string
}

variable "authorization_scopes" {
  description = "OAuth scopes a protected route asks for. With at least one scope API Gateway expects a Cognito ACCESS token whose `scope` claim holds one of them (the token the frontend sends). With an empty list it expects an ID token and rejects an access token."
  type        = list(string)
  default     = ["openid"] # the frontend signs in with the scopes openid + email, so every access token carries openid
}

variable "routes" {
  description = "One entry per Lambda-backed route. A route requires a valid Cognito token unless it says public = true: then it has no authorizer at all (anybody on the internet can call it, so its function must check the caller itself) and it gets a lower throttle of its own than the stage default."
  type = map(object({
    route_key     = string # e.g. "GET /requests/{id}"
    function_name = string
    invoke_arn    = string
    public        = optional(bool, false) # opt-in: a route is protected unless someone says otherwise
  }))

  # The resource tree is built from these paths. The depth limit comes from main.tf: one
  # resource block per level, because a resource cannot refer to its own instances.
  validation {
    condition = alltrue([
      for route in values(var.routes) :
      can(regex("^(GET|POST|PUT|PATCH|DELETE) /[^ /]+(/[^ /]+){0,3}$", route.route_key))
    ])
    error_message = "Every route_key must look like \"METHOD /path/{param}\": METHOD is one of GET, POST, PUT, PATCH, DELETE (OPTIONS is added by the module for CORS), and the path has 1 to 4 segments. A deeper path needs one more level block in main.tf."
  }

  validation {
    condition     = length(distinct([for route in values(var.routes) : route.route_key])) == length(var.routes)
    error_message = "Two routes have the same route_key: a method on a path can have only one integration."
  }
}

variable "stage_name" {
  description = "Stage name; it is the first segment of the URL path (https://<id>.execute-api.<region>.amazonaws.com/<stage>)."
  type        = string
  default     = "v1"
}

variable "log_retention_days" {
  description = "How long CloudWatch keeps the access logs."
  type        = number
  default     = 30 # the same as the functions' logs, so an API call and its function's lines expire together
}
