# REST API, not HTTP API: a REST API has a Cognito user pool authorizer, a per-method
# throttle, X-Ray tracing on the stage and gateway responses (the answers API Gateway
# produces itself, such as 401 and 429). The price: it costs more per request, and it has no
# CORS switch, so the preflight answers are built by hand below.
resource "aws_api_gateway_rest_api" "this" {
  name = var.name

  endpoint_configuration {
    types = ["REGIONAL"] # served from the API's own region, no CloudFront distribution in front
  }
}

# ---------------------------------------------------------------------------
# Routes -> resource tree
# ---------------------------------------------------------------------------

locals {
  # "GET /requests/{id}" -> method "GET", path "/requests/{id}"
  parsed_routes = {
    for key, route in var.routes : key => {
      method = split(" ", route.route_key)[0]
      path   = split(" ", route.route_key)[1]
    }
  }

  # Every path that needs a resource: the route paths and all their parents.
  # "/requests/{id}/retry" needs "/requests", "/requests/{id}" and itself.
  # split("/", "/a/b") is ["", "a", "b"]: the empty first element is the root.
  resource_paths = toset(flatten([
    for route in local.parsed_routes : [
      for depth in range(1, length(split("/", route.path))) :
      join("/", slice(split("/", route.path), 0, depth + 1))
    ]
  ]))

  # For each path: its level (1 = directly under the root), its own segment (the "path
  # part", `{id}` for a path parameter) and the path of its parent.
  resource_tree = {
    for path in local.resource_paths : path => {
      depth       = length(split("/", path)) - 1
      path_part   = element(split("/", path), length(split("/", path)) - 1)
      parent_path = join("/", slice(split("/", path), 0, length(split("/", path)) - 1))
    }
  }

  # Path -> resource, from all levels together.
  resources = merge(
    aws_api_gateway_resource.level1,
    aws_api_gateway_resource.level2,
    aws_api_gateway_resource.level3,
    aws_api_gateway_resource.level4,
  )

  # For each path that has at least one route: the methods it answers, and the OPTIONS
  # method for the CORS preflight is added to the list. A path that is only the parent of
  # other paths (say "/webhooks") has no method, so a browser never asks it anything and
  # it gets no OPTIONS either.
  allowed_methods = {
    for path in distinct([for route in local.parsed_routes : route.path]) : path => join(",", concat(
      sort(distinct([for route in local.parsed_routes : route.method if route.path == path])),
      ["OPTIONS"],
    ))
  }
}

# A resource needs its parent's id, and a resource block cannot refer to its own instances,
# so there is one block per level. The variable "routes" limits the depth to four levels.
resource "aws_api_gateway_resource" "level1" {
  for_each = { for path, node in local.resource_tree : path => node if node.depth == 1 }

  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id   = aws_api_gateway_rest_api.this.root_resource_id
  path_part   = each.value.path_part
}

resource "aws_api_gateway_resource" "level2" {
  for_each = { for path, node in local.resource_tree : path => node if node.depth == 2 }

  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id   = aws_api_gateway_resource.level1[each.value.parent_path].id
  path_part   = each.value.path_part
}

resource "aws_api_gateway_resource" "level3" {
  for_each = { for path, node in local.resource_tree : path => node if node.depth == 3 }

  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id   = aws_api_gateway_resource.level2[each.value.parent_path].id
  path_part   = each.value.path_part
}

resource "aws_api_gateway_resource" "level4" {
  for_each = { for path, node in local.resource_tree : path => node if node.depth == 4 }

  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id   = aws_api_gateway_resource.level3[each.value.parent_path].id
  path_part   = each.value.path_part
}

# ---------------------------------------------------------------------------
# Authorizer, methods, Lambda integrations
# ---------------------------------------------------------------------------

# Rejects a missing, expired or foreign token with 401 before any Lambda runs (and is billed).
# Unlike the JWT authorizer of an HTTP API, it checks the signature, the expiry and the user
# pool, but not the app client: every app client of this pool is accepted (there is one).
resource "aws_api_gateway_authorizer" "cognito" {
  name            = "cognito"
  rest_api_id     = aws_api_gateway_rest_api.this.id
  type            = "COGNITO_USER_POOLS"
  provider_arns   = [var.cognito_user_pool_arn]
  identity_source = "method.request.header.Authorization"
}

resource "aws_api_gateway_method" "route" {
  for_each = var.routes

  rest_api_id = aws_api_gateway_rest_api.this.id
  resource_id = local.resources[local.parsed_routes[each.key].path].id
  http_method = local.parsed_routes[each.key].method

  # Protected by default. A public route has no authorizer, so API Gateway lets every caller
  # through to the function: only routes whose function authenticates the caller itself may
  # say public = true.
  authorization = each.value.public ? "NONE" : "COGNITO_USER_POOLS"
  authorizer_id = each.value.public ? null : aws_api_gateway_authorizer.cognito.id

  # With scopes the authorizer validates an access token and asks for one of these scopes;
  # without them it would accept an ID token only.
  authorization_scopes = each.value.public ? null : var.authorization_scopes
}

resource "aws_api_gateway_integration" "route" {
  for_each = var.routes

  rest_api_id             = aws_api_gateway_rest_api.this.id
  resource_id             = aws_api_gateway_method.route[each.key].resource_id
  http_method             = aws_api_gateway_method.route[each.key].http_method
  type                    = "AWS_PROXY" # the whole request goes to the Lambda, its answer goes back as is
  integration_http_method = "POST"      # API Gateway always invokes Lambda with POST, whatever the client sent
  uri                     = each.value.invoke_arn
}

# Lets this API, and no other, invoke the function, and only for this method and path.
resource "aws_lambda_permission" "api" {
  for_each = var.routes

  # One statement per route, so two routes may point at the same function.
  statement_id  = "AllowInvokeFromRestApi-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = each.value.function_name
  principal     = "apigateway.amazonaws.com"

  # execution ARN / stage / METHOD / path. The stage is a wildcard so that the "Test" button of
  # the console (a stage of its own) works too. A path parameter `{id}` becomes `*`: it matches
  # the parameter's value whichever form API Gateway puts into the ARN (the value or the name).
  source_arn = "${aws_api_gateway_rest_api.this.execution_arn}/*/${local.parsed_routes[each.key].method}${replace(local.parsed_routes[each.key].path, "/\\{[^}]+\\}/", "*")}"
}

# ---------------------------------------------------------------------------
# CORS
#
# An HTTP API answers the browser's preflight (OPTIONS) itself; a REST API does not, so every
# resource that has routes gets an OPTIONS method with a MOCK integration: API Gateway answers
# 200 with the CORS headers and no Lambda runs (and is billed). The OPTIONS method has no
# authorizer because a preflight never carries the Authorization header.
#
# Allow-Origin is `*`. That is acceptable here because authorization is a bearer token that the
# page puts into the Authorization header by hand: there are no cookies and the API never sends
# Access-Control-Allow-Credentials, so a page on another origin cannot make the browser attach
# the user's credentials, and without a token the API answers 401 to it anyway. A fixed origin
# would protect nothing more, and a REST API cannot pick the header per request without a Lambda.
# The Lambdas add Allow-Origin to their own responses (backend code).
# ---------------------------------------------------------------------------

locals {
  cors_allow_origin  = "'*'"
  cors_allow_headers = "'Content-Type,Authorization,X-Amzn-Trace-Id'" # X-Amzn-Trace-Id: the browser starts the X-Ray trace
}

resource "aws_api_gateway_method" "options" {
  for_each = local.allowed_methods

  rest_api_id   = aws_api_gateway_rest_api.this.id
  resource_id   = local.resources[each.key].id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "options" {
  for_each = local.allowed_methods

  rest_api_id = aws_api_gateway_rest_api.this.id
  resource_id = aws_api_gateway_method.options[each.key].resource_id
  http_method = aws_api_gateway_method.options[each.key].http_method
  type        = "MOCK"

  # The mock integration needs a request template with a status code to answer with.
  request_templates = {
    "application/json" = jsonencode({ statusCode = 200 })
  }
}

# The method response declares which headers the answer may carry; the integration response
# below gives them their values.
resource "aws_api_gateway_method_response" "options" {
  for_each = local.allowed_methods

  rest_api_id = aws_api_gateway_rest_api.this.id
  resource_id = aws_api_gateway_method.options[each.key].resource_id
  http_method = aws_api_gateway_method.options[each.key].http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Origin"  = true
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
  }
}

resource "aws_api_gateway_integration_response" "options" {
  for_each = local.allowed_methods

  rest_api_id = aws_api_gateway_rest_api.this.id
  resource_id = aws_api_gateway_method.options[each.key].resource_id
  http_method = aws_api_gateway_method.options[each.key].http_method
  status_code = aws_api_gateway_method_response.options[each.key].status_code

  # The value of a header is a quoted string: the single quotes are part of the syntax.
  response_parameters = {
    "method.response.header.Access-Control-Allow-Origin"  = local.cors_allow_origin
    "method.response.header.Access-Control-Allow-Headers" = local.cors_allow_headers
    "method.response.header.Access-Control-Allow-Methods" = "'${each.value}'"
  }

  # The integration must exist before its response can be attached to it.
  depends_on = [aws_api_gateway_integration.options]
}

# The answers API Gateway makes on its own (401 from the authorizer, 403 for an unknown path,
# 429 from the throttle, 5xx) never reach a Lambda, so the Lambdas cannot add the CORS header
# to them. Without it the browser hides the status behind a generic network error.
resource "aws_api_gateway_gateway_response" "cors" {
  for_each = toset(["DEFAULT_4XX", "DEFAULT_5XX"])

  rest_api_id   = aws_api_gateway_rest_api.this.id
  response_type = each.value

  response_parameters = {
    "gatewayresponse.header.Access-Control-Allow-Origin" = local.cors_allow_origin
  }

  # The body template API Gateway puts on these two responses by itself, written out. Left out, every
  # plan saw a difference (the template is in AWS, not in the code), and because the deployment's
  # redeployment hash (below) covers this resource, that difference made every plan replace the
  # deployment, which the deploy workflow's guard against deletions then refused.
  response_templates = {
    "application/json" = "{\"message\":$context.error.messageString}"
  }
}

# ---------------------------------------------------------------------------
# Deployment and stage
# ---------------------------------------------------------------------------

# A REST API serves nothing until it is deployed, and a deployment is a snapshot: changing a
# method does not change what is live. The trigger is a hash of everything that makes up the
# snapshot, so any change to the routes replaces the deployment (and the stage switches to the
# new one). The new deployment is created before the old one is removed, because the stage
# points at the old one until it is updated.
resource "aws_api_gateway_deployment" "this" {
  rest_api_id = aws_api_gateway_rest_api.this.id

  triggers = {
    redeployment = sha1(jsonencode([
      local.resources,
      aws_api_gateway_authorizer.cognito,
      aws_api_gateway_method.route,
      aws_api_gateway_integration.route,
      aws_api_gateway_method.options,
      aws_api_gateway_integration.options,
      aws_api_gateway_method_response.options,
      aws_api_gateway_integration_response.options,
      aws_api_gateway_gateway_response.cors,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${var.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_api_gateway_stage" "this" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  deployment_id = aws_api_gateway_deployment.this.id
  stage_name    = var.stage_name # part of the URL: https://<id>.execute-api.<region>.amazonaws.com/<stage>/requests

  xray_tracing_enabled = true # the trace shows the time spent in API Gateway before the Lambda starts

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn

    # No client IP, user agent or token claims: personal data does not belong in logs.
    format = jsonencode({
      requestId          = "$context.requestId"
      httpMethod         = "$context.httpMethod"
      resourcePath       = "$context.resourcePath"
      status             = "$context.status"
      responseLatency    = "$context.responseLatency"
      integrationLatency = "$context.integrationLatency"
      integrationStatus  = "$context.integrationStatus"
    })
  }

  # API Gateway refuses to enable access logs on a stage until the account has a CloudWatch role.
  depends_on = [aws_api_gateway_account.this]
}

# Throttling protects the account's Lambda concurrency limit (10) from a runaway client.
# Even if every route used its full limit (5 protected routes x 5 requests/s + the public
# route's 2 requests/s = 27 requests/s), that is far below what 10 concurrent executions of a
# ~100 ms handler can serve (about 100 requests/s).
resource "aws_api_gateway_method_settings" "default" {
  rest_api_id = aws_api_gateway_rest_api.this.id
  stage_name  = aws_api_gateway_stage.this.stage_name
  method_path = "*/*" # every method of the stage

  settings {
    throttling_burst_limit = 10
    throttling_rate_limit  = 5

    # Off on purpose, and said out loud: detailed metrics are billed as custom metrics, and
    # execution logs with data trace write whole requests and responses (tokens, personal data)
    # to CloudWatch. The access log above is the only log of the API.
    metrics_enabled    = false
    logging_level      = "OFF"
    data_trace_enabled = false
  }
}

# A public route is the one place where anonymous calls reach a Lambda (on the protected
# routes API Gateway turns them away before any function runs), so it gets a lower limit than
# the default above. Its legitimate traffic is a few events a day; the caller reads 429 as
# "try again later" (contracts/webhook-api.md), so a limit that is too low delays an event
# and never loses one. The burst is twice the rate, the same ratio as the default.
resource "aws_api_gateway_method_settings" "public" {
  for_each = { for key, route in var.routes : key => route if route.public }

  rest_api_id = aws_api_gateway_rest_api.this.id
  stage_name  = aws_api_gateway_stage.this.stage_name

  # "resource path without the leading slash / METHOD", e.g. "webhooks/partner/POST". Reading the
  # method from the method resource also makes the setting wait for the method (the stage's
  # deployment already contains it).
  method_path = "${trimprefix(local.parsed_routes[each.key].path, "/")}/${aws_api_gateway_method.route[each.key].http_method}"

  settings {
    throttling_burst_limit = 4
    throttling_rate_limit  = 2
  }

  # Two changes to the same stage at the same time can fail with a conflict, so the settings
  # are applied one after the other.
  depends_on = [aws_api_gateway_method_settings.default]
}

# ---------------------------------------------------------------------------
# Account-level CloudWatch role
# ---------------------------------------------------------------------------

# API Gateway writes access logs with a role that is set once per AWS account and region,
# not per API. This resource sets it: if another stack in this account and region sets a
# different role, the last apply wins. Destroying this resource does not unset the role in
# the account; the role itself is removed with the module.
resource "aws_api_gateway_account" "this" {
  cloudwatch_role_arn = aws_iam_role.cloudwatch.arn

  # A role that is created a second ago may not be usable yet; wait for its policy at least.
  depends_on = [aws_iam_role_policy_attachment.cloudwatch]
}

data "aws_iam_policy_document" "cloudwatch_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["apigateway.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cloudwatch" {
  name               = "${var.name}-apigw-cloudwatch"
  assume_role_policy = data.aws_iam_policy_document.cloudwatch_assume.json
}

# The AWS managed policy for exactly this role. It allows the log actions on every log group
# (Resource "*"): that is what AWS documents for this account-level role, and a policy of our
# own scoped to one log group would break as soon as a second API is added in the region.
resource "aws_iam_role_policy_attachment" "cloudwatch" {
  role       = aws_iam_role.cloudwatch.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs"
}
