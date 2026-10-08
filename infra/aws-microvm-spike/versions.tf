terraform {
  required_version = ">= 1.8.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = merge({ Project = "t3-microvm-spike", ManagedBy = "opentofu" }, var.tags)
  }
}
