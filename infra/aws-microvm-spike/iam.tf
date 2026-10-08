data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "microvm_logs" {
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:${local.partition}:logs:${var.region}:${local.account_id}:log-group:*"]
  }
}

# --- MicroVM image build -------------------------------------------------

resource "aws_iam_role" "microvm_build" {
  name               = "${var.name}-microvm-build"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

data "aws_iam_policy_document" "microvm_build" {
  source_policy_documents = [data.aws_iam_policy_document.microvm_logs.json]

  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/*"]
  }
}

resource "aws_iam_role_policy" "microvm_build" {
  role   = aws_iam_role.microvm_build.id
  policy = data.aws_iam_policy_document.microvm_build.json
}

# --- Thread VM runtime ---------------------------------------------------
# Credentials reach the VM through instance metadata; efs-utils uses them for
# the IAM-authorized mount.

resource "aws_iam_role" "microvm_execution" {
  name               = "${var.name}-microvm-execution"
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

data "aws_iam_policy_document" "microvm_execution" {
  source_policy_documents = [data.aws_iam_policy_document.microvm_logs.json]

  statement {
    actions   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
    resources = [aws_efs_file_system.this.arn]
    condition {
      test     = "StringEquals"
      variable = "elasticfilesystem:AccessPointArn"
      values   = [aws_efs_access_point.work.arn]
    }
  }

  # efs-utils resolves mount targets itself when DNS does not answer from the VM.
  statement {
    actions   = ["elasticfilesystem:DescribeMountTargets", "ec2:DescribeAvailabilityZones"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "microvm_execution" {
  role   = aws_iam_role.microvm_execution.id
  policy = data.aws_iam_policy_document.microvm_execution.json
}

# --- VPC egress connector ------------------------------------------------

data "aws_iam_policy_document" "network_connector_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = var.network_connector_trust_services
    }
  }
}

resource "aws_iam_role" "network_connector_operator" {
  name               = "${var.name}-network-connector-operator"
  assume_role_policy = data.aws_iam_policy_document.network_connector_trust.json
}

data "aws_iam_policy_document" "network_connector_operator" {
  statement {
    sid     = "CreateENI"
    actions = ["ec2:CreateNetworkInterface"]
    resources = [
      "arn:${local.partition}:ec2:*:*:network-interface/*",
      "arn:${local.partition}:ec2:*:*:subnet/*",
      "arn:${local.partition}:ec2:*:*:security-group/*",
    ]
  }

  statement {
    sid       = "TagENI"
    actions   = ["ec2:CreateTags"]
    resources = ["arn:${local.partition}:ec2:*:*:network-interface/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:ManagedResourceOperator"
      values   = ["network-connectors.lambda.amazonaws.com"]
    }
  }

  statement {
    sid = "ManageENI"
    actions = [
      "ec2:DeleteNetworkInterface",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeSubnets",
      "ec2:DescribeVpcs",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "network_connector_operator" {
  role   = aws_iam_role.network_connector_operator.id
  policy = data.aws_iam_policy_document.network_connector_operator.json
}

# --- Tenant server task --------------------------------------------------

resource "aws_iam_role" "task_execution" {
  name               = "${var.name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

data "aws_iam_policy_document" "task" {
  # In production a broker owns these calls; IAM cannot scope them to one
  # tenant's VMs. The spike has a single tenant, so the server calls directly.
  statement {
    sid = "ThreadVms"
    actions = [
      "lambda:RunMicrovm",
      "lambda:GetMicrovm",
      "lambda:ListMicrovms",
      "lambda:SuspendMicrovm",
      "lambda:ResumeMicrovm",
      "lambda:TerminateMicrovm",
      "lambda:CreateMicrovmAuthToken",
      "lambda:GetMicrovmImage",
      "lambda:GetNetworkConnector",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "PassThreadVmRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.microvm_execution.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }

  statement {
    sid       = "Workspaces"
    actions   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
    resources = [aws_efs_file_system.this.arn]
  }

  statement {
    sid = "EcsExec"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task" {
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}
