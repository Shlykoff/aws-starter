locals {
  prefix = "${var.project}-${var.env}" # every resource name is <project>-<env>-<thing>

  # One entry per Lambda. The routes are the ones in docs/api.md; each function gets
  # exactly one DynamoDB action, the one its handler needs.
  functions = {
    create-request = { route_key = "POST /requests", dynamodb_action = "dynamodb:PutItem" }
    list-requests  = { route_key = "GET /requests", dynamodb_action = "dynamodb:Query" }
    get-request    = { route_key = "GET /requests/{id}", dynamodb_action = "dynamodb:GetItem" }
  }

  # Origins the browser app runs on: Vite's dev server always, CloudFront when it exists.
  # They feed both CORS (API) and the login redirects (Cognito). The for-expression is
  # empty when the static site is switched off.
  site_origins = [for site in module.static_site : "https://${site.domain_name}"]
  web_origins  = concat(["http://localhost:5173"], local.site_origins)
}

module "requests_table" {
  source = "../../modules/dynamodb"

  name = "${local.prefix}-requests"
}

module "function" {
  source   = "../../modules/lambda-function"
  for_each = local.functions

  name       = "${local.prefix}-${each.key}"
  source_dir = "${var.backend_dist_dir}/${each.key}"

  environment = {
    TABLE_NAME   = module.requests_table.name
    LOG_LEVEL    = "info"
    NODE_OPTIONS = "--enable-source-maps" # the build is minified: stack traces map back to the TypeScript source
  }

  policy_statements = [{
    actions   = [each.value.dynamodb_action]
    resources = [module.requests_table.arn]
  }]
}

module "cognito" {
  source = "../../modules/cognito"

  name_prefix   = local.prefix
  domain_prefix = var.cognito_domain_prefix
  web_origins   = local.web_origins
}

module "api" {
  source = "../../modules/http-api"

  name            = "${local.prefix}-api"
  allowed_origins = local.web_origins
  jwt_issuer      = module.cognito.issuer
  jwt_audience    = [module.cognito.client_id]

  routes = {
    for name, fn in local.functions : name => {
      route_key     = fn.route_key
      function_name = module.function[name].name
      invoke_arn    = module.function[name].invoke_arn
    }
  }
}

# Optional: whether CloudFront can be used on this account has not been verified.
module "static_site" {
  source = "../../modules/static-site"
  count  = var.enable_static_site ? 1 : 0

  name = "${local.prefix}-site"
}
