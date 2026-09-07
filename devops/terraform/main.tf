terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region                      = var.aws_region
  skip_credentials_validation = var.ci_dry_run
  skip_requesting_account_id  = var.ci_dry_run
  skip_metadata_api_check     = var.ci_dry_run
}

resource "aws_security_group" "sorokeep_sg" {
  name_prefix = "sorokeep-daemon-sg-"
  description = "Security group for Sorokeep daemon"

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_iam_role" "sorokeep_role" {
  count = var.aws_secrets_manager_arn != "" ? 1 : 0
  name  = "sorokeep-daemon-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = { Service = "ec2.amazonaws.com" }
      }
    ]
  })
}

resource "aws_iam_role_policy" "secrets_manager_policy" {
  count  = var.aws_secrets_manager_arn != "" ? 1 : 0
  name   = "sorokeep-secrets-policy"
  role   = aws_iam_role.sorokeep_role[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = var.aws_secrets_manager_arn
      }
    ]
  })
}

resource "aws_iam_instance_profile" "sorokeep_profile" {
  count = var.aws_secrets_manager_arn != "" ? 1 : 0
  name  = "sorokeep-daemon-profile"
  role  = aws_iam_role.sorokeep_role[0].name
}

resource "aws_instance" "sorokeep_daemon" {
  ami           = var.ami_id
  instance_type = var.instance_type

  iam_instance_profile   = var.aws_secrets_manager_arn != "" ? aws_iam_instance_profile.sorokeep_profile[0].name : null
  vpc_security_group_ids = [aws_security_group.sorokeep_sg.id]

  user_data = templatefile("${path.module}/user_data.sh.tpl", {
    network                 = var.network
    rpc_url                 = var.rpc_url
    poll_interval           = var.poll_interval
    secret_key_env          = var.secret_key_env
    aws_secrets_manager_arn = var.aws_secrets_manager_arn
  })

  tags = {
    Name = "sorokeep-daemon"
  }
}
