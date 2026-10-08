variable "region" {
  type        = string
  default     = "eu-central-1"
  description = "Region with Lambda MicroVMs."
}

variable "name" {
  type        = string
  default     = "t3-spike"
  description = "Prefix for every resource name."
}

variable "vpc_id" {
  type        = string
  description = "Existing VPC. Needs DNS hostnames and DNS support enabled."
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Private subnets with NAT egress, in at least two AZs. Hosts the EFS mount targets, the server task, the VPC endpoints, and the MicroVM egress connector's ENIs."

  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "Use at least two private subnets in different AZs."
  }
}

variable "tenant_id" {
  type        = string
  default     = "spike"
  description = "The one tenant this spike provisions. Becomes the EFS directory /tenants/<tenant_id>."
}

variable "server_image" {
  type        = string
  default     = null
  description = "Tenant server image. Leave null for stage 1: a placeholder that mounts EFS and answers HTTP on 3773."
}

variable "server_cpu" {
  type    = number
  default = 1024
}

variable "server_memory" {
  type    = number
  default = 2048
}

variable "server_environment" {
  type        = map(string)
  default     = {}
  description = "Extra server environment. Stage 2 adds the MicroVM image and egress connector ARNs here."
}

variable "create_microvm_vpc_endpoint" {
  type        = bool
  default     = true
  description = "Interface endpoint for com.amazonaws.<region>.lambda-microvm so server-to-VM traffic stays in the VPC. Set false if the VPC already has one with private DNS."
}

variable "create_lambda_vpc_endpoint" {
  type        = bool
  default     = false
  description = "Interface endpoint for the Lambda (and MicroVM management) API. NAT works without it."
}

variable "network_connector_trust_services" {
  type        = list(string)
  default     = ["lambda.amazonaws.com"]
  description = "Service principals allowed to assume the network connector operator role. The MicroVM docs do not state it; change this if create-network-connector reports it cannot assume the role."
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "egress_connector_arn" {
  type        = string
  default     = null
  description = "ARN printed by scripts/create-network-connector.sh. With server_image set, the server runs threads in MicroVMs."
}

variable "microvm_image_arn" {
  type        = string
  default     = null
  description = "Thread VM image. Defaults to the image scripts/build-thread-image.sh creates."
}
