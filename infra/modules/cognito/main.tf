data "aws_region" "current" {}

locals {
  # Cognito matches redirect URLs exactly, so they are built from one list of origins.
  callback_urls = [for origin in var.web_origins : "${origin}/auth/callback"]
  logout_urls   = [for origin in var.web_origins : "${origin}/"]
}

resource "aws_cognito_user_pool" "this" {
  name = "${var.name_prefix}-users"

  # ESSENTIALS is the tier AWS uses for new pools and includes a free monthly allowance of
  # active users (see the Cognito pricing page for the current numbers). Stated explicitly
  # so a provider default change cannot silently move the pool to another tier.
  user_pool_tier = "ESSENTIALS"

  # Sign in with the e-mail address; there is no separate user name to remember.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"] # needed for the "forgot password" e-mail flow

  # Addresses that differ only in letter case are the same user.
  username_configuration {
    case_sensitive = false
  }

  # No self sign-up: the owner creates users (console or `admin-create-user`).
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = true
  }

  # MFA is off: demo project, fake users. For real users turn it on (TOTP).
  mfa_configuration = "OFF"

  # Recover the account by e-mail only; there is no SMS setup (and no SMS spend).
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  # A dev stack must be destroyable with `terraform destroy`.
  deletion_protection = "INACTIVE"
}

# Public client for a browser SPA: nothing in a browser can keep a secret, so no client
# secret; the authorization code flow is protected by PKCE instead.
resource "aws_cognito_user_pool_client" "web" {
  name         = "${var.name_prefix}-web"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret = false

  # Authorization code grant only (no implicit grant: it would put tokens in the URL).
  # PKCE is not a switch here: the frontend sends a code_challenge on /oauth2/authorize
  # and Cognito then requires the matching code_verifier on /oauth2/token.
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  # aws.cognito.signin.user.admin is Cognito's own built-in scope for the self-service API
  # (GetUser and its siblings): without it on the token, GetUser answers NotAuthorizedException
  # even though the token is otherwise valid. It only ever acts on the token's own account.
  allowed_oauth_scopes         = ["openid", "email", "aws.cognito.signin.user.admin"]
  supported_identity_providers = ["COGNITO"]

  callback_urls = local.callback_urls
  logout_urls   = local.logout_urls

  # The hosted UI signs the user in on its own, so the app needs no direct sign-in flow.
  # Only refreshing a session is done from the app, with the refresh token.
  explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH"]

  # A wrong user name and a wrong password look the same, so the login page does not
  # reveal which e-mail addresses have an account.
  prevent_user_existence_errors = "ENABLED"
}

# Hosted UI domain: https://<prefix>.auth.<region>.amazoncognito.com
resource "aws_cognito_user_pool_domain" "this" {
  domain       = var.domain_prefix
  user_pool_id = aws_cognito_user_pool.this.id

  # 1 = the classic hosted UI, 2 = "managed login". Managed login needs an extra branding
  # resource before it renders anything, and the classic UI does everything this project
  # needs (login, logout, forgot password). Simpler to explain, so classic.
  managed_login_version = 1
}
