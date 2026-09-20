# Single-table design for stage 1: one partition per user (pk = USER#<sub>), one item per
# request (sk = REQ#<ULID>). Key design is described in docs/api.md.
resource "aws_dynamodb_table" "this" {
  name = var.name

  # Provisioned with a small fixed capacity stays inside the always-free allowance (see the
  # DynamoDB pricing page for the current numbers). On-demand would suit spiky or unknown
  # traffic, this load is not. No autoscaling on purpose: this load does not need it, and
  # it would add scaling policies and alarms.
  billing_mode   = "PROVISIONED"
  read_capacity  = 5
  write_capacity = 5

  hash_key  = "pk"
  range_key = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  # Point-in-time recovery is off (it is billed per GB) and the table uses the default
  # AWS-owned encryption key (free). `server_side_encryption` is left out deliberately:
  # `enabled = false` there means "AWS-owned key", not "unencrypted", and reads badly.
}
