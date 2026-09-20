# Remote state for the bootstrap stack itself, kept in the bucket this stack creates.
#
# First run on an empty account: the bucket doesn't exist yet. Move this file aside,
# run `terraform init && terraform apply` (local state), put the file back and run
# `terraform init -migrate-state -backend-config=backend.tfbackend`.
#
# The bucket name is not hardcoded so the AWS account ID stays out of the repository.
# It comes from backend.tfbackend (git-ignored, see backend.tfbackend.example).
terraform {
  backend "s3" {
    key          = "bootstrap/terraform.tfstate"
    region       = "eu-north-1"
    encrypt      = true
    use_lockfile = true # native S3 locking, Terraform >= 1.10
  }
}
