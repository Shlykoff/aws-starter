locals {
  # Named once: the index below and the ARN in outputs.tf must agree on it.
  by_request_id_index = "by-request-id"
}

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

  # Finds a request by its id alone. The webhook event names the request but not its owner,
  # and the table's key starts with the owner (docs/api.md, "Storage"). An index may use the
  # table's sort key as its own partition key, so no new attribute is needed; sk = REQ#<ULID>
  # is unique across the table because ULIDs are.
  #
  # KEYS_ONLY: the index holds pk and sk and nothing else, which is all the webhook needs to
  # address the item. It stays tiny and holds no request text.
  #
  # Capacity is the index's own (an index is billed like a small table): 5 RCU / 5 WCU, as the
  # table. The always-free allowance is 25 RCU / 25 WCU per account for tables and indexes
  # together, so table + index use 10 of 25 of each. Adding the index to a table that already
  # holds items is an in-place update: DynamoDB backfills the index by itself.
  #
  # `key_schema` instead of `hash_key`: the provider marks `hash_key` in this block deprecated.
  global_secondary_index {
    name            = local.by_request_id_index
    projection_type = "KEYS_ONLY"
    read_capacity   = 5
    write_capacity  = 5

    key_schema {
      attribute_name = "sk"
      key_type       = "HASH"
    }
  }

  # Point-in-time recovery is off (it is billed per GB) and the table uses the default
  # AWS-owned encryption key (free). `server_side_encryption` is left out deliberately:
  # `enabled = false` there means "AWS-owned key", not "unencrypted", and reads badly.
}
