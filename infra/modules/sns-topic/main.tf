data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

# A standard topic (a FIFO topic could not send e-mail, and Lambda's failure destination
# accepts standard topics only). Not encrypted with KMS on purpose: AWS services such as
# CloudWatch can publish to an encrypted topic only if it uses a customer managed key whose
# policy names them (see the SNS docs, "Managing Amazon SNS encryption keys"). The messages
# carry only ids and alarm data, never request text.
resource "aws_sns_topic" "this" {
  name = var.name
}

# Optional e-mail subscription. SNS sends a confirmation mail first; until the link in it
# is clicked, the subscription receives nothing, and SNS deletes an unconfirmed
# subscription after 48 hours.
resource "aws_sns_topic_subscription" "email" {
  count = var.email == null ? 0 : 1

  topic_arn = aws_sns_topic.this.arn
  protocol  = "email"
  endpoint  = var.email

  # With a filter policy only the matching messages are mailed. The filter looks at the
  # message attributes (not the body), which is where the publisher puts `status`.
  filter_policy       = var.filter_policy == null ? null : jsonencode(var.filter_policy)
  filter_policy_scope = var.filter_policy == null ? null : "MessageAttributes"
}

# Replaces the default topic policy, so it must contain everything that needs a
# resource-based permission. Principals of this account (the functions' roles) publish
# through their own IAM policies, so the only extra statement is the one for CloudWatch.
data "aws_iam_policy_document" "cloudwatch_alarms" {
  count = var.allow_cloudwatch_alarms ? 1 : 0

  statement {
    sid       = "AllowCloudWatchAlarms"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.this.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    # Only alarms of this account (the confused-deputy protection the CloudWatch docs
    # recommend); without the conditions any account's alarm could publish here.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudwatch:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:alarm:*"]
    }
  }
}

resource "aws_sns_topic_policy" "cloudwatch_alarms" {
  count = var.allow_cloudwatch_alarms ? 1 : 0

  arn    = aws_sns_topic.this.arn
  policy = data.aws_iam_policy_document.cloudwatch_alarms[0].json
}
