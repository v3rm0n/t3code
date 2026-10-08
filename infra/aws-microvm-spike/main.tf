data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

data "aws_vpc" "this" {
  id = var.vpc_id
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition

  # The server and every thread VM mount the work access point at this same
  # path, so a path in a prompt or a checkpoint means one file everywhere.
  work_mount_path  = "/t3/work"
  state_mount_path = "/t3/state"

  microvm_image_name = "${var.name}-thread"
  microvm_image_arn  = "arn:${local.partition}:lambda:${var.region}:${local.account_id}:microvm-image:${local.microvm_image_name}"
  microvm_log_group  = "/${var.name}/microvm"

  # Placeholder for stage 1: proves EFS mounts and that VMs can reach the
  # server's port through the egress connector, before the T3 image exists.
  placeholder_image = "public.ecr.aws/docker/library/node:24-bookworm-slim"
  placeholder_command = [
    "node",
    "-e",
    "require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({placeholder:true,path:q.url}))}).listen(3773,'0.0.0.0')",
  ]
}

# --- Security groups -------------------------------------------------------

resource "aws_security_group" "server" {
  name        = "${var.name}-server"
  description = "T3 tenant server task"
  vpc_id      = var.vpc_id
}

resource "aws_security_group" "microvm_egress" {
  name        = "${var.name}-microvm-egress"
  description = "ENIs of the MicroVM VPC egress connector"
  vpc_id      = var.vpc_id
}

resource "aws_security_group" "efs" {
  name        = "${var.name}-efs"
  description = "EFS mount targets"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_egress_rule" "server_all" {
  security_group_id = aws_security_group.server.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# Thread VMs call the server's /mcp endpoint.
resource "aws_vpc_security_group_ingress_rule" "server_from_microvms" {
  security_group_id            = aws_security_group.server.id
  referenced_security_group_id = aws_security_group.microvm_egress.id
  ip_protocol                  = "tcp"
  from_port                    = 3773
  to_port                      = 3773
}

resource "aws_vpc_security_group_egress_rule" "microvm_all" {
  security_group_id = aws_security_group.microvm_egress.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "efs_from_server" {
  security_group_id            = aws_security_group.efs.id
  referenced_security_group_id = aws_security_group.server.id
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
}

resource "aws_vpc_security_group_ingress_rule" "efs_from_microvms" {
  security_group_id            = aws_security_group.efs.id
  referenced_security_group_id = aws_security_group.microvm_egress.id
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
}

# --- VPC endpoints -----------------------------------------------------------

resource "aws_security_group" "endpoints" {
  count       = var.create_microvm_vpc_endpoint || var.create_lambda_vpc_endpoint ? 1 : 0
  name        = "${var.name}-endpoints"
  description = "Interface endpoints for Lambda and MicroVM traffic"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  count             = length(aws_security_group.endpoints)
  security_group_id = aws_security_group.endpoints[0].id
  cidr_ipv4         = data.aws_vpc.this.cidr_block
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_endpoint" "lambda_microvm" {
  count               = var.create_microvm_vpc_endpoint ? 1 : 0
  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.${var.region}.lambda-microvm"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = var.private_subnet_ids
  security_group_ids  = [aws_security_group.endpoints[0].id]
  private_dns_enabled = true
  tags                = { Name = "${var.name}-lambda-microvm" }
}

resource "aws_vpc_endpoint" "lambda" {
  count               = var.create_lambda_vpc_endpoint ? 1 : 0
  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.${var.region}.lambda"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = var.private_subnet_ids
  security_group_ids  = [aws_security_group.endpoints[0].id]
  private_dns_enabled = true
  tags                = { Name = "${var.name}-lambda" }
}

# --- Storage -----------------------------------------------------------------

resource "aws_s3_bucket" "artifacts" {
  bucket_prefix = "${var.name}-microvm-artifacts-"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_ecr_repository" "server" {
  name         = "${var.name}/server"
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_cloudwatch_log_group" "server" {
  name              = "/${var.name}/server"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "microvm" {
  name              = local.microvm_log_group
  retention_in_days = 14
}
