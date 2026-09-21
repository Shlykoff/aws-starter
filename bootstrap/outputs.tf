output "state_bucket" {
  description = "Bucket for the remote state of infra/ (goes into its backend config)."
  value       = aws_s3_bucket.tfstate.id
}

output "github_deploy_role_arn" {
  description = "Role for GitHub Actions to assume (set as the AWS_DEPLOY_ROLE_ARN repository secret)."
  value       = aws_iam_role.github_deploy.arn
}
