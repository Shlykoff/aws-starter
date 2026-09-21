# Saved Logs Insights queries: the ones the owner would otherwise type from docs/api.md, "Logs".
# They appear in the console under Logs Insights > Queries > Saved queries (the "/" in a name
# makes a folder). The fields they use (event, outcome, toStatus, ...) are the ones of the
# request events; Insights parses the JSON of our lines by itself, so no `parse` is needed.
#
# A saved query holds no time range; the console asks for it when the query runs. Logs Insights
# bills (against the 5 GB of the free tier) by the data it scans, so a query names only the log
# groups it needs, and the console's time range should be as narrow as the question.

locals {
  all_groups = values(var.lambda_log_group_names)

  queries = {
    # Comments in a query start with #.
    request-timeline = {
      log_groups = local.all_groups
      query      = <<-EOT
        # Replace the ULID below with the id of the request (from the API or the table), then run.
        fields @timestamp, event, fromStatus, toStatus, role, attempt, outcome, httpStatus, partnerMs, sinceCreatedMs
        | filter requestId = "<the ULID>" and ispresent(event)
        | sort @timestamp asc
      EOT
    }

    failed-requests = {
      log_groups = local.all_groups
      query      = <<-EOT
        # Requests that ran out of attempts in the chosen time range, newest first.
        fields @timestamp, requestId, attempt, sinceCreatedMs
        | filter event = "request_failed"
        | sort @timestamp desc
        | limit 100
      EOT
    }

    slowest-deliveries = {
      log_groups = local.all_groups
      query      = <<-EOT
        # The 20 requests that took longest from creation to "sent". attempt > 1 explains most of them.
        fields @timestamp, requestId, sinceCreatedMs, attempt
        | filter event = "request_sent"
        | sort sinceCreatedMs desc
        | limit 20
      EOT
    }

    attempts-by-outcome = {
      log_groups = local.all_groups
      query      = <<-EOT
        # Every call to the recipient, counted by what came of it. httpStatus is empty when the
        # recipient did not answer (timeout, network error) or was not called at all.
        filter event = "delivery_attempted"
        | stats count(*) as attempts by outcome, httpStatus
        | sort attempts desc
      EOT
    }

    # Only receive-webhook writes these lines, so only its group is read (a lot less data to scan).
    webhook-events = {
      log_groups = [var.webhook_log_group_name]
      query      = <<-EOT
        # What became of the recipient's calls: applied, duplicate, ignored, unauthorized, ...
        filter message = "Webhook handled"
        | stats count(*) as calls by outcome
        | sort calls desc
      EOT
    }

    log-guard-hits = {
      log_groups = local.all_groups
      query      = <<-EOT
        # Lines where the log guard replaced a value. @message shows the field NAME that was
        # not allowed (the value is never in the log); @log is the function.
        fields @timestamp, @log, @message
        | filter @message like "[unlisted]" or @message like "[rejected]"
        | sort @timestamp desc
        | limit 50
      EOT
    }
  }
}

resource "aws_cloudwatch_query_definition" "this" {
  for_each = local.queries

  name            = "${var.name_prefix}/${each.key}"
  query_string    = each.value.query
  log_group_names = each.value.log_groups
}
