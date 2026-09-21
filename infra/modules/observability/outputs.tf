output "dashboard_name" {
  description = "Name of the CloudWatch dashboard (CloudWatch > Dashboards)."
  value       = aws_cloudwatch_dashboard.delivery.dashboard_name
}
