# Long-term log archive (modules/log-archive): every line of every function's log group and of
# the API access log is copied to S3 within minutes and kept for 13 months. CloudWatch Logs
# stays the hot tier with its own, shorter retention; this is the cold one, queried with Athena.
#
# How to query (the names are in the outputs below): run Athena in the workgroup
# <project>-<env>-logs, database <project>_<env>_logs (dashes become underscores), table
# log_archive, and always filter on year, month and day; the workgroup has two saved queries
# (the timeline of one request, failed requests per day) that show the shape. The archive
# holds the AWS account id in every record, so the bucket stays private.

module "log_archive" {
  source = "../../modules/log-archive"

  prefix = local.prefix

  # One subscription filter per entry. The names come from the modules that create the groups,
  # so a renamed function cannot leave its group out of the archive. The labels only have to be
  # unique and known at plan time: the function names, plus the three below.
  log_group_names = merge(
    { for name, fn in module.function : name => fn.log_group_name },
    {
      enqueuer        = module.enqueuer.log_group_name
      delivery-worker = module.delivery_worker.log_group_name
      api             = module.api.access_log_group_name
    },
  )
}

output "log_archive_bucket" {
  description = "Bucket that holds the log archive (logs/ = the archive, athena-results/ = query results)."
  value       = module.log_archive.bucket_name
}

output "log_archive_athena_workgroup" {
  description = "Athena workgroup to query the log archive in (fixed result location, 1 GB scan limit)."
  value       = module.log_archive.athena_workgroup
}

output "log_archive_athena_database" {
  description = "Glue database of the log archive; the table is log_archive."
  value       = module.log_archive.athena_database
}
