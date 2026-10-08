output "region" {
  value = var.region
}

output "name" {
  value = var.name
}

output "tenant_id" {
  value = var.tenant_id
}

output "private_subnet_ids" {
  value = var.private_subnet_ids
}

output "efs_file_system_id" {
  value = aws_efs_file_system.this.id
}

output "efs_state_access_point_id" {
  value = aws_efs_access_point.state.id
}

output "efs_work_access_point_id" {
  value = aws_efs_access_point.work.id
}

output "efs_mount_target_ips" {
  description = "Fallback for VMs that cannot resolve the file system's DNS name."
  value       = [for target in aws_efs_mount_target.this : target.ip_address]
}

output "work_mount_path" {
  value = local.work_mount_path
}

output "artifacts_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "ecr_repository_url" {
  value = aws_ecr_repository.server.repository_url
}

output "microvm_image_name" {
  value = local.microvm_image_name
}

output "microvm_image_arn" {
  value = local.microvm_image_arn
}

output "microvm_build_role_arn" {
  value = aws_iam_role.microvm_build.arn
}

output "microvm_execution_role_arn" {
  value = aws_iam_role.microvm_execution.arn
}

output "microvm_log_group" {
  value = aws_cloudwatch_log_group.microvm.name
}

output "microvm_egress_security_group_id" {
  value = aws_security_group.microvm_egress.id
}

output "network_connector_operator_role_arn" {
  value = aws_iam_role.network_connector_operator.arn
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "ecs_service_name" {
  value = aws_ecs_service.server.name
}
