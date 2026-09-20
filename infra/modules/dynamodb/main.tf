# Single-table design: one partition per user (pk = USER#<sub>), one item per request
# (sk = REQ#<ULID>). Key design is described in docs/api.md.
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

  # Change stream for the delivery pipeline (docs/api.md): the enqueuer reads it and puts
  # every new request on the queue. NEW_IMAGE = the item as it looks after the write; the
  # enqueuer never needs the old version. The stream holds the request text, so nothing
  # that reads it may log a record. Turning this on updates the table in place.
  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"

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
