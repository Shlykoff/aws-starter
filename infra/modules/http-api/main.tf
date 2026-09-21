# HTTP API, not REST API: cheaper per request, lower latency, and a built-in
# JWT authorizer, so no authorizer Lambda is needed. The REST-only features (API keys,
# usage plans, request validation) are not needed here.
resource "aws_apigatewayv2_api" "this" {
  name          = var.name
  protocol_type = "HTTP"

  # API Gateway answers the browser's CORS preflight (OPTIONS) itself, before the
  # authorizer runs, and adds these headers to the responses of the Lambdas.
  cors_configuration {
    allow_origins = var.allowed_origins
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["authorization", "content-type"]
    max_age       = 300 # browsers may cache the preflight answer for 5 minutes
  }
}

# Rejects a missing, expired or foreign token with 401 before any Lambda runs (and is billed).
resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.this.id
  name             = "cognito"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer = var.jwt_issuer
    # A Cognito access token carries the app client id in `client_id` (an ID token has it
    # in `aud`); API Gateway accepts either claim, so one entry covers both.
    audience = var.jwt_audience
  }
}

resource "aws_apigatewayv2_integration" "this" {
  for_each = var.routes

  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY" # the whole request goes to the Lambda, its answer goes back as is
  integration_uri        = each.value.invoke_arn
  integration_method     = "POST" # API Gateway always invokes Lambda with POST, whatever the client sent
  payload_format_version = "2.0"  # the event shape docs/api.md describes
}

resource "aws_apigatewayv2_route" "this" {
  for_each = var.routes

  api_id    = aws_apigatewayv2_api.this.id
  route_key = each.value.route_key
  target    = "integrations/${aws_apigatewayv2_integration.this[each.key].id}"

  # Protected by default. A public route has no authorizer, so API Gateway lets every caller
  # through to the function: only routes whose function authenticates the caller itself may
  # say public = true.
  authorization_type = each.value.public ? "NONE" : "JWT"
  authorizer_id      = each.value.public ? null : aws_apigatewayv2_authorizer.jwt.id
}

# Lets this API, and no other, invoke the function.
resource "aws_lambda_permission" "api" {
  for_each = var.routes

  statement_id  = "AllowInvokeFromHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = each.value.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${var.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  api_id = aws_apigatewayv2_api.this.id
  name   = "$default" # no stage name in the URL: https://<id>.execute-api.<region>.amazonaws.com/requests

  auto_deploy = true # route and integration changes go live without a separate deployment resource

  # Throttling protects the account's Lambda concurrency limit (10) from a runaway client.
  # Even if every route used its full limit (5 protected routes x 5 requests/s + the public
  # route's 2 requests/s = 27 requests/s), that is far below what 10 concurrent executions of a
  # ~100 ms handler can serve (about 100 requests/s).
  default_route_settings {
    throttling_burst_limit = 10
    throttling_rate_limit  = 5
  }

  # A public route is the one place where anonymous calls reach a Lambda (on the protected
  # routes API Gateway turns them away before any function runs), so it gets a lower limit than
  # the default above. Its legitimate traffic is a few events a day; the caller reads 429 as
  # "try again later" (contracts/webhook-api.md), so a limit that is too low delays an event
  # and never loses one. The burst is twice the rate, the same ratio as the default.
  dynamic "route_settings" {
    for_each = { for name, route in var.routes : name => route if route.public }
    iterator = route

    content {
      route_key              = route.value.route_key
      throttling_burst_limit = 4
      throttling_rate_limit  = 2
    }
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn

    # No client IP, user agent or token claims: personal data does not belong in logs.
    format = jsonencode({
      requestId               = "$context.requestId"
      requestTime             = "$context.requestTime"
      httpMethod              = "$context.httpMethod"
      routeKey                = "$context.routeKey"
      status                  = "$context.status"
      responseLatency         = "$context.responseLatency"
      integrationErrorMessage = "$context.integrationErrorMessage"
      authorizerError         = "$context.authorizer.error"
    })
  }

  # A route setting names a route by its key, and API Gateway can refuse a setting for a route
  # that does not exist yet. Terraform sees no link between the two (the key is only a string),
  # so this makes the routes come first: on a fresh stack, and when the first public route is
  # added to a running one.
  depends_on = [aws_apigatewayv2_route.this]
}
