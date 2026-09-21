variable "name" {
  description = "Base name, e.g. aws-starter-dev-deliveries. The bucket name adds the account ID because bucket names are global."
  type        = string
}

variable "expiration_days" {
  description = "Exchange records are deleted this many days after they were written."
  type        = number
  default     = 30
}
