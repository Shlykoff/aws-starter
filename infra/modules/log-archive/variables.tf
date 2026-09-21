variable "prefix" {
  description = "<project>-<env>, e.g. aws-starter-dev. Every name in the module (bucket, stream, roles, workgroup) starts with it; the CI deploy role may create only roles that start with the project name."
  type        = string
}

variable "log_group_names" {
  description = "The CloudWatch log groups to archive, as { label = log group name }. The labels must be known at plan time (they become resource addresses); the names may be computed. One subscription filter is created per entry."
  type        = map(string)
}

variable "expiration_days" {
  description = "Archived lines (and Firehose's failed batches) are deleted this many days after they were written. 395 = 13 months: a full year plus a month to compare against."
  type        = number
  default     = 395
}
