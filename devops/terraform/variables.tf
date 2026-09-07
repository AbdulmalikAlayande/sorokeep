variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "ci_dry_run" {
  description = "Enable to skip AWS API checks during CI plan dry-runs"
  type        = bool
  default     = false
}

variable "ami_id" {
  description = "AMI ID for the EC2 instance"
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.micro"
}

variable "network" {
  description = "Soroban network to monitor"
  type        = string
  default     = "testnet"
}

variable "rpc_url" {
  description = "Custom RPC URL (optional)"
  type        = string
  default     = ""
}

variable "poll_interval" {
  description = "Polling interval in milliseconds"
  type        = number
  default     = 300000
}

variable "secret_key_env" {
  description = "Environment variable name containing the Stellar secret key"
  type        = string
  default     = "STELLAR_SECRET_KEY"
}

variable "aws_secrets_manager_arn" {
  description = "AWS Secrets Manager ARN to fetch the secret key from (optional)"
  type        = string
  default     = ""
}
