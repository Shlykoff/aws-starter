locals {
  log_group_name = "/aws/lambda/${var.name}" # the name Lambda writes to by default
}

# Created before the function (see depends_on below). If Lambda created the group on its
# first invocation instead, it would have no retention (logs kept forever = a slow bill).
resource "aws_cloudwatch_log_group" "this" {
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
}

# One role per function: a bug or a compromise in one handler cannot use the permissions
# of another.
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = var.name # must start with "<project>-": the CI deploy role may manage only those roles
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "permissions" {
  # Own log group only, instead of the managed AWSLambdaBasicExecutionRole, which allows
  # logs:CreateLogGroup and writing to any log group in the account. The group already
  # exists, so CreateLogGroup is not needed. ":*" matches the log streams inside it.
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }

  # What the function needs besides logging, resource-scoped by the caller.
  dynamic "statement" {
    for_each = var.policy_statements

    content {
      actions   = statement.value.actions
      resources = statement.value.resources
    }
  }
}

resource "aws_iam_role_policy" "this" {
  name   = "permissions"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.permissions.json
}

# Terraform zips the build output itself (the backend build produces plain directories,
# no zips). The archive lives in .terraform/, which is git-ignored. The hash below makes
# Terraform redeploy the function exactly when the code changes.
data "archive_file" "this" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${path.root}/.terraform/archives/${var.name}.zip"
}

resource "aws_lambda_function" "this" {
  function_name = var.name
  role          = aws_iam_role.this.arn

  runtime       = "nodejs24.x"
  architectures = ["arm64"] # Graviton: cheaper per GB-second than x86
  handler       = "index.handler"

  filename         = data.archive_file.this.output_path
  source_code_hash = data.archive_file.this.output_base64sha256

  # The handlers make one DynamoDB call, so anything slower than 10 s is a bug. A short
  # timeout also caps how long a stuck call holds one of the account's 10 concurrent
  # executions.
  timeout     = var.timeout
  memory_size = var.memory_size # CPU share scales with memory; 256 MB is plenty for one SDK call

  # No VPC (reaching the internet from one needs a NAT Gateway, billed by the hour) and no
  # reserved concurrency (the account limit is 10 in total; reserving some would starve
  # the other functions).

  environment {
    variables = var.environment
  }

  depends_on = [
    aws_cloudwatch_log_group.this, # so that our group, with retention, exists before Lambda can create its own
    aws_iam_role_policy.this,      # so that the first invocation is already allowed to log
  ]
}
