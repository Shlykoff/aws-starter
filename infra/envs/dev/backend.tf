# Remote state of the dev environment, in the bucket created by bootstrap/.
#
# The bucket name is not hardcoded so the AWS account ID stays out of the repository.
# It comes from backend.tfbackend (git-ignored, see backend.tfbackend.example):
#   terraform init -backend-config=backend.tfbackend
terraform {
  backend "s3" {
    key          = "infra/dev/terraform.tfstate"
    region       = "eu-north-1"
    encrypt      = true
    use_lockfile = true # native S3 locking, Terraform >= 1.10
  }
}
