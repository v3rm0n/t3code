resource "aws_ecs_cluster" "this" {
  name = var.name

  configuration {
    execute_command_configuration {
      logging = "DEFAULT"
    }
  }
}

locals {
  server_environment = merge(
    {
      AWS_REGION                = var.region
      T3_SPIKE_TENANT_ID        = var.tenant_id
      T3_SPIKE_WORK_MOUNT_PATH  = local.work_mount_path
      T3_SPIKE_STATE_MOUNT_PATH = local.state_mount_path
      # Read by the stage 2 server when it launches thread VMs.
      T3CODE_MICROVM_EXECUTION_ROLE_ARN  = aws_iam_role.microvm_execution.arn
      T3CODE_MICROVM_EFS_FILE_SYSTEM_ID  = aws_efs_file_system.this.id
      T3CODE_MICROVM_EFS_ACCESS_POINT_ID = aws_efs_access_point.work.id
      T3CODE_MICROVM_LOG_GROUP           = local.microvm_log_group
    },
    # Stage 2: the real server, running threads in MicroVMs that mount the
    # work access point at the same path as this task.
    var.server_image != null && var.egress_connector_arn != null ? {
      T3CODE_THREAD_HOST                  = "microvm"
      T3CODE_SHARED_DIR                   = local.work_mount_path
      HOME                                = "${local.work_mount_path}/home"
      T3CODE_MICROVM_IMAGE_ARN            = coalesce(var.microvm_image_arn, local.microvm_image_arn)
      T3CODE_MICROVM_EGRESS_CONNECTOR_ARN = var.egress_connector_arn
    } : {},
    var.server_environment,
  )
}

resource "aws_ecs_task_definition" "server" {
  family                   = "${var.name}-server"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.server_cpu
  memory                   = var.server_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  volume {
    name = "state"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.this.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.state.id
        iam             = "ENABLED"
      }
    }
  }

  volume {
    name = "work"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.this.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.work.id
        iam             = "ENABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name      = "server"
      image     = coalesce(var.server_image, local.placeholder_image)
      command   = var.server_image == null ? local.placeholder_command : null
      essential = true
      portMappings = [
        { containerPort = 3773, protocol = "tcp" },
      ]
      mountPoints = [
        { sourceVolume = "state", containerPath = local.state_mount_path },
        { sourceVolume = "work", containerPath = local.work_mount_path },
      ]
      environment = [
        for key, value in local.server_environment : { name = key, value = value }
      ]
      linuxParameters = { initProcessEnabled = true }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.server.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "server"
        }
      }
    },
  ])
}

resource "aws_ecs_service" "server" {
  name                   = "${var.name}-server"
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.server.arn
  desired_count          = 1
  launch_type            = "FARGATE"
  enable_execute_command = true
  propagate_tags         = "SERVICE"

  # SQLite has one writer: never run the old and new task together.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.server.id]
    assign_public_ip = false
  }

  depends_on = [aws_efs_mount_target.this, aws_efs_file_system_policy.this]
}
