data "aws_caller_identity" "current" {}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  state_bucket = "${var.project}-tfstate-${local.account_id}"
}

# ---------------------------------------------------------------------------
# Remote state for the main stack (infra/).
# This bootstrap stack itself keeps a local state file: it is the chicken that
# creates the egg (the bucket), and it changes rarely.
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "tfstate" {
  bucket = local.state_bucket
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  versioning_configuration {
    status = "Enabled" # lets us roll back a corrupted or wrongly-applied state
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

# ---------------------------------------------------------------------------
# Cost guard. AWS Budgets is account-wide, which is what we want: the most
# common surprise bill is a forgotten resource, not a misbehaving Lambda.
# ---------------------------------------------------------------------------
resource "aws_budgets_budget" "monthly" {
  name         = "${var.project}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}

# ---------------------------------------------------------------------------
# GitHub Actions -> AWS without long-lived access keys (OIDC).
# GitHub signs a short-lived token per workflow run; AWS exchanges it for
# temporary credentials, but only if the token comes from our repo and branch.
# Note: an account can have only one OIDC provider per URL.
# ---------------------------------------------------------------------------
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Only workflow runs on main of this exact repository can assume the role. The prefix
    # is GitHub's immutable form (it carries the numeric owner and repository IDs), so a
    # renamed, deleted-and-recreated or transferred repository does not inherit this trust.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["${var.github_oidc_subject_prefix}:ref:refs/heads/main"]
    }
  }
}

# Named "github-deploy-<project>" on purpose: the IAM statement below only
# covers roles named "<project>-*", so this role cannot edit itself.
resource "aws_iam_role" "github_deploy" {
  name                 = "github-deploy-${var.project}"
  assume_role_policy   = data.aws_iam_policy_document.github_assume.json
  max_session_duration = 3600
}

# PowerUserAccess = everything except IAM/Organizations/Account management.
resource "aws_iam_role_policy_attachment" "deploy_power_user" {
  role       = aws_iam_role.github_deploy.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

# ...plus IAM, but only for the execution roles this project creates.
#
# Known trade-off: with iam:PutRolePolicy / AttachRolePolicy a deploy could
# still grant one of *our* roles broad rights. Closing that fully needs a
# permissions boundary on every role Terraform creates; worth adding for a
# real environment, deliberately skipped here to keep the example readable.
data "aws_iam_policy_document" "deploy_iam" {
  statement {
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:PassRole",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePolicy",
      "iam:GetRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
    ]
    resources = ["arn:aws:iam::${local.account_id}:role/${var.project}-*"]
  }
}

resource "aws_iam_role_policy" "deploy_iam" {
  name   = "manage-project-roles"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.deploy_iam.json
}
