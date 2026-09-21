# Querying the archive with Athena: a Glue database and table over s3://<bucket>/logs/, a
# workgroup that bounds what a query may cost, and two saved queries.
#
# How to query: use the workgroup (the console's workgroup switch, or --work-group on the
# CLI), the database and the table named in the outputs, and ALWAYS filter on year, month and
# day in the WHERE. The table has no stored partitions (partition projection computes them
# from the filter); a query without a date filter lists every day of the projected range in S3
# and scans everything. The workgroup stops a query at 1 GB scanned, as a safety net only.

locals {
  # Glue and Athena names take letters, digits and underscores: no dashes.
  database_name = "${replace(var.prefix, "-", "_")}_logs"
  table_name    = "log_archive"

  # What both saved queries read from. The table has one row per CloudWatch batch (the
  # envelope); a log line is an element of its `logevents` array, which the queries unnest.
  table_ref = "${local.database_name}.${local.table_name}"
}

resource "aws_glue_catalog_database" "this" {
  name = local.database_name
}

resource "aws_glue_catalog_table" "this" {
  name          = local.table_name
  database_name = aws_glue_catalog_database.this.name
  table_type    = "EXTERNAL_TABLE" # Athena only reads the files; dropping the table deletes nothing

  parameters = {
    EXTERNAL = "TRUE"

    # Partition projection: Athena computes the partitions from the WHERE clause instead of
    # reading them from the catalog, so there is no crawler and no MSCK REPAIR, and a new day
    # is queryable the moment its first object exists. The keys are strings, as in AWS's
    # documented Hive-layout examples; the integer type with `digits` yields the zero-padded
    # names the archiver writes (month=09). The path is built from the table location and the
    # key names (logs/year=2026/month=09/day=21/), which is the layout of the archiver's keys.
    "projection.enabled"      = "true"
    "projection.year.type"    = "integer"
    "projection.year.range"   = "2026,2035" # short on purpose (a query without a year filter lists every projected day in S3); extend it before 2036
    "projection.month.type"   = "integer"
    "projection.month.range"  = "1,12"
    "projection.month.digits" = "2"
    "projection.day.type"     = "integer"
    "projection.day.range"    = "1,31"
    "projection.day.digits"   = "2"
  }

  partition_keys {
    name = "year"
    type = "string"
  }

  partition_keys {
    name = "month"
    type = "string"
  }

  partition_keys {
    name = "day"
    type = "string"
  }

  storage_descriptor {
    location      = "s3://${aws_s3_bucket.this.id}/logs/"
    input_format  = "org.apache.hadoop.mapred.TextInputFormat"
    output_format = "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat"

    ser_de_info {
      # OpenX reads JSON lines and matches keys case-insensitively, which is what lets the
      # camelCase envelope (messageType, logEvents, ...) fill lowercase columns (Glue stores
      # column names in lowercase).
      serialization_library = "org.openx.data.jsonserde.JsonSerDe"

      parameters = {
        # One malformed or empty line must not fail a query over 13 months of archive: it
        # becomes a NULL row instead.
        "ignore.malformed.json" = "true"
      }
    }

    # The envelope CloudWatch Logs sends, which the archiver writes as it is (only `logevents` is
    # split by day).
    columns {
      name = "messagetype" # always DATA_MESSAGE: the archiver does not write CloudWatch's CONTROL_MESSAGE health check
      type = "string"
    }

    columns {
      name = "owner" # the AWS account id: the reason the bucket stays private
      type = "string"
    }

    columns {
      name = "loggroup"
      type = "string"
    }

    columns {
      name = "logstream"
      type = "string"
    }

    columns {
      name = "subscriptionfilters"
      type = "array<string>"
    }

    columns {
      name = "logevents" # one element per log line; timestamp is epoch milliseconds
      type = "array<struct<id:string,timestamp:bigint,message:string>>"
    }
  }
}

# ---------------------------------------------------------------------------
# The workgroup
# ---------------------------------------------------------------------------

resource "aws_athena_workgroup" "this" {
  name = "${var.prefix}-logs"

  # `terraform destroy` must work although queries have been run in the workgroup (its query
  # history would block the delete).
  force_destroy = true

  configuration {
    # Clients may not override the result location or the limit below; a query from a script
    # or another console session cannot bypass them.
    enforce_workgroup_configuration = true

    # A query that would scan more than 1 GB is cancelled. Athena bills per TB scanned, so a
    # forgotten date filter costs about half a cent at most, instead of growing with the archive.
    bytes_scanned_cutoff_per_query = 1073741824

    engine_version {
      selected_engine_version = "AUTO" # let AWS pick the current engine (v3 today)
    }

    result_configuration {
      output_location = "s3://${aws_s3_bucket.this.id}/athena-results/"

      encryption_configuration {
        encryption_option = "SSE_S3"
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Saved queries. Both are meant to be edited before they are run: the request id, and the
# date range (a filter on the three partition columns, nothing else prunes).
# ---------------------------------------------------------------------------

# A Lambda line in the text log format is `timestamp <TAB> requestId <TAB> LEVEL <TAB> {json}`
# and an API access log line is plain JSON, so in both cases regexp_extract takes everything
# from the first `{` to the last `}`. Lines without one (START, END, REPORT) give NULL and drop
# out at the request id filter.
resource "aws_athena_named_query" "request_timeline" {
  name        = "timeline-of-one-request"
  description = "Every event of one request across all functions, in order. Edit the request id and the date range."
  workgroup   = aws_athena_workgroup.this.id
  database    = aws_glue_catalog_database.this.name

  query = <<-SQL
    -- The timeline of one request. Edit the request id and the date range.
    -- The archive's day is the day of the line (UTC). A request that was sent again days later has
    -- lines on several days: take the range that covers them. For a range across two months,
    -- use OR groups, e.g.
    --   (year = '2026' AND month = '08' AND day >= '30') OR (year = '2026' AND month = '09' AND day <= '02')
    WITH log_lines AS (
      SELECT
        event_ts,
        loggroup,
        regexp_extract(event_message, '(\{.*\})', 1) AS body
      FROM ${local.table_ref}
      CROSS JOIN UNNEST(logevents) AS t (event_id, event_ts, event_message)
      WHERE year = '2026' AND month = '09' AND day BETWEEN '20' AND '22'
        AND messagetype = 'DATA_MESSAGE'
    ),
    request_events AS (
      SELECT
        event_ts,
        loggroup,
        json_extract_scalar(body, '$.requestId') AS request_id,
        json_extract_scalar(body, '$.event') AS event,
        json_extract_scalar(body, '$.role') AS role,
        json_extract_scalar(body, '$.fromStatus') AS from_status,
        json_extract_scalar(body, '$.toStatus') AS to_status,
        TRY_CAST(json_extract_scalar(body, '$.attempt') AS bigint) AS attempt,
        json_extract_scalar(body, '$.outcome') AS outcome,
        TRY_CAST(json_extract_scalar(body, '$.httpStatus') AS bigint) AS http_status,
        TRY_CAST(json_extract_scalar(body, '$.partnerMs') AS bigint) AS partner_ms,
        TRY_CAST(json_extract_scalar(body, '$.sinceCreatedMs') AS bigint) AS since_created_ms
      FROM log_lines
    )
    SELECT
      from_unixtime(CAST(event_ts AS double) / 1000) AS event_time,
      loggroup,
      event,
      role,
      from_status,
      to_status,
      attempt,
      outcome,
      http_status,
      partner_ms,
      since_created_ms
    FROM request_events
    WHERE request_id = 'PUT-THE-REQUEST-ID-HERE'
      AND event IS NOT NULL
    ORDER BY event_ts
  SQL
}

# One request_failed event is written each time a request ends in `failed`; a request that is
# sent again and fails again counts once for each day it failed on (DISTINCT is per day).
resource "aws_athena_named_query" "failed_requests_per_day" {
  name        = "failed-requests-per-day"
  description = "How many requests ended in `failed`, per day (UTC). Edit the date range."
  workgroup   = aws_athena_workgroup.this.id
  database    = aws_glue_catalog_database.this.name

  query = <<-SQL
    -- Failed requests per day. Edit the date range: a whole year is cheap while the archive is
    -- small; narrow it to a month, or to days, as it grows.
    WITH log_lines AS (
      SELECT
        event_ts,
        regexp_extract(event_message, '(\{.*\})', 1) AS body
      FROM ${local.table_ref}
      CROSS JOIN UNNEST(logevents) AS t (event_id, event_ts, event_message)
      WHERE year = '2026'
        AND messagetype = 'DATA_MESSAGE'
    ),
    failures AS (
      SELECT
        CAST(from_unixtime(CAST(event_ts AS double) / 1000) AS date) AS day_utc,
        json_extract_scalar(body, '$.requestId') AS request_id
      FROM log_lines
      WHERE json_extract_scalar(body, '$.event') = 'request_failed'
    )
    SELECT
      day_utc,
      count(DISTINCT request_id) AS failed_requests
    FROM failures
    GROUP BY day_utc
    ORDER BY day_utc
  SQL
}
