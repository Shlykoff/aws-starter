output "bucket_name" {
  description = "Name of the archive bucket (logs/ holds the archive, athena-results/ the query results)."
  value       = aws_s3_bucket.this.id
}

output "athena_workgroup" {
  description = "Athena workgroup to run queries in (it fixes the result location and the bytes-scanned limit)."
  value       = aws_athena_workgroup.this.name
}

output "athena_database" {
  description = "Glue database that holds the archive table."
  value       = aws_glue_catalog_database.this.name
}

output "athena_table" {
  description = "Glue table over the archive (partitioned by year, month and day)."
  value       = aws_glue_catalog_table.this.name
}

output "archiver_function_name" {
  description = "Name of the archiver function (dimension of its Lambda metrics)."
  value       = module.archiver.name
}
