# Metrics, alarms, a dashboard and saved Logs Insights queries for the delivery pipeline. Its own
# file, so that it stays out of main.tf. Everything is in modules/observability, which explains
# the choices (why only 8 custom metrics, why no dimensions, why exactly 10 alarms in total).

locals {
  # The log group of every function of the project, by short name: the 6 API functions (one loop
  # in main.tf), the enqueuer and the delivery-worker. The log guard is watched in all of them.
  lambda_log_group_names = merge(
    { for name, fn in module.function : name => fn.log_group_name },
    {
      "enqueuer"        = module.enqueuer.log_group_name
      "delivery-worker" = module.delivery_worker.log_group_name
    },
  )
}

module "observability" {
  source = "../../modules/observability"

  name_prefix = local.prefix
  namespace   = "${var.project}/${var.env}" # the same value as METRICS_NAMESPACE of the delivery-worker in main.tf

  alarm_topic_arn        = module.alerts_topic.arn
  lambda_log_group_names = local.lambda_log_group_names

  worker_function_name   = module.delivery_worker.name
  worker_log_group_name  = module.delivery_worker.log_group_name
  worker_timeout_seconds = local.worker_timeout_seconds

  webhook_function_name  = module.function["receive-webhook"].name
  webhook_log_group_name = module.function["receive-webhook"].log_group_name

  archiver_function_name = module.log_archive.archiver_function_name

  api_id     = module.api.api_id
  queue_name = module.deliveries_queue.name
  dlq_name   = module.deliveries_queue.dlq_name
  table_name = module.requests_table.name

  # The two alarms of main.tf, which the dashboard shows next to the module's own eight.
  other_alarm_arns = [
    aws_cloudwatch_metric_alarm.dlq_not_empty.arn,
    aws_cloudwatch_metric_alarm.enqueuer_iterator_age.arn,
  ]
}
