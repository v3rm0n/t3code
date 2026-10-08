# One file system for every tenant. Each tenant gets two access points:
# `state` (T3 database, secrets, logs) for its server only, and `work`
# (projects, worktrees, attachments, HOME) shared by its server and VMs.
# Both enforce uid/gid 1000, the `t3` user in the server and VM images.

resource "aws_efs_file_system" "this" {
  encrypted        = true
  performance_mode = "generalPurpose"
  throughput_mode  = "elastic"
  tags             = { Name = "${var.name}-workspaces" }
}

resource "aws_efs_mount_target" "this" {
  for_each        = toset(var.private_subnet_ids)
  file_system_id  = aws_efs_file_system.this.id
  subnet_id       = each.value
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_access_point" "state" {
  file_system_id = aws_efs_file_system.this.id

  posix_user {
    uid = 1000
    gid = 1000
  }

  root_directory {
    path = "/tenants/${var.tenant_id}/state"
    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "0750"
    }
  }

  tags = { Name = "${var.name}-${var.tenant_id}-state" }
}

resource "aws_efs_access_point" "work" {
  file_system_id = aws_efs_file_system.this.id

  posix_user {
    uid = 1000
    gid = 1000
  }

  root_directory {
    path = "/tenants/${var.tenant_id}/work"
    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "0755"
    }
  }

  tags = { Name = "${var.name}-${var.tenant_id}-work" }
}

# IAM decides who mounts what: the server gets both access points, thread VMs
# only `work`, and nothing mounts without TLS.
resource "aws_efs_file_system_policy" "this" {
  file_system_id = aws_efs_file_system.this.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = { AWS = "*" }
        Action    = "*"
        Resource  = aws_efs_file_system.this.arn
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "ServerMountsStateAndWork"
        Effect    = "Allow"
        Principal = { AWS = aws_iam_role.task.arn }
        Action    = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
        Resource  = aws_efs_file_system.this.arn
        Condition = {
          StringEquals = {
            "elasticfilesystem:AccessPointArn" = [
              aws_efs_access_point.state.arn,
              aws_efs_access_point.work.arn,
            ]
          }
        }
      },
      {
        Sid       = "ThreadVmsMountWork"
        Effect    = "Allow"
        Principal = { AWS = aws_iam_role.microvm_execution.arn }
        Action    = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
        Resource  = aws_efs_file_system.this.arn
        Condition = {
          StringEquals = { "elasticfilesystem:AccessPointArn" = aws_efs_access_point.work.arn }
        }
      },
    ]
  })
}
