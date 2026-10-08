#!/usr/bin/env bash
# Creates the VPC egress connector thread VMs use to reach EFS and the tenant
# server. The AWS provider has no resource for it yet, so this wraps the CLI.
# Idempotent: re-running returns the existing connector.
#
#   AWS_PROFILE=sandbox infra/aws-microvm-spike/scripts/create-network-connector.sh
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${INFRA_DIR}/.spike"
mkdir -p "${STATE_DIR}"

output() { tofu -chdir="${INFRA_DIR}" output -raw "$1"; }

REGION="$(output region)"
NAME="$(output name)-egress"
SUBNETS="$(tofu -chdir="${INFRA_DIR}" output -json private_subnet_ids | tr -d '[:space:]')"
SECURITY_GROUP="$(output microvm_egress_security_group_id)"
OPERATOR_ROLE="$(output network_connector_operator_role_arn)"

existing="$(aws lambda-core list-network-connectors --region "${REGION}" \
  --query "NetworkConnectors[?Name=='${NAME}'].Arn | [0]" --output text 2>/dev/null || true)"

if [[ -n "${existing}" && "${existing}" != "None" ]]; then
  ARN="${existing}"
  echo "Using existing connector ${ARN}"
else
  ARN="$(aws lambda-core create-network-connector --region "${REGION}" \
    --name "${NAME}" \
    --client-token "${NAME}" \
    --operator-role "${OPERATOR_ROLE}" \
    --configuration "{\"VpcEgressConfiguration\":{\"SubnetIds\":${SUBNETS},\"SecurityGroupIds\":[\"${SECURITY_GROUP}\"],\"NetworkProtocol\":\"IPv4\",\"AssociatedComputeResourceTypes\":[\"MicroVm\"]}}" \
    --query Arn --output text)"
  echo "Created connector ${ARN}"
fi

echo "Waiting for ACTIVE (provisioning can take up to 10 minutes)..."
for _ in $(seq 1 120); do
  state="$(aws lambda-core get-network-connector --region "${REGION}" \
    --identifier "${ARN}" --query State --output text)"
  case "${state}" in
    ACTIVE)
      echo "${ARN}" > "${STATE_DIR}/network-connector-arn"
      echo "Connector ACTIVE: ${ARN}"
      exit 0
      ;;
    FAILED | DELETE_FAILED)
      aws lambda-core get-network-connector --region "${REGION}" --identifier "${ARN}"
      exit 1
      ;;
  esac
  sleep 5
done
echo "Timed out waiting for ${ARN}" >&2
exit 1
