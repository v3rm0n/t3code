#!/usr/bin/env bash
# Builds the thread-runner MicroVM image: stages the artifact zip, uploads it,
# and creates the image (or a new version of it), then waits for the build.
# Run create-network-connector.sh first; the image lists the connector.
#
#   AWS_PROFILE=sandbox infra/aws-microvm-spike/scripts/build-thread-image.sh
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${INFRA_DIR}/../.." && pwd)"
STATE_DIR="${INFRA_DIR}/.spike"
mkdir -p "${STATE_DIR}"

output() { tofu -chdir="${INFRA_DIR}" output -raw "$1"; }

REGION="$(output region)"
IMAGE_NAME="$(output microvm_image_name)"
BUCKET="$(output artifacts_bucket)"
BUILD_ROLE="$(output microvm_build_role_arn)"
LOG_GROUP="$(output microvm_log_group)"
CONNECTOR_ARN="$(cat "${STATE_DIR}/network-connector-arn")"
MEMORY_MIB="${MEMORY_MIB:-4096}"

node "${REPO_ROOT}/apps/thread-runner/scripts/build-image-artifact.ts"
ZIP="${REPO_ROOT}/apps/thread-runner/.artifact/thread-runner-image.zip"
KEY="thread-runner/$(date +%Y%m%d-%H%M%S).zip"
aws s3 cp "${ZIP}" "s3://${BUCKET}/${KEY}" --region "${REGION}"

BASE_IMAGE_ARN="${BASE_IMAGE_ARN:-$(aws lambda-microvms list-managed-microvm-images --region "${REGION}" \
  --query 'items[0].imageArn' --output text)}"
echo "Base image: ${BASE_IMAGE_ARN}"

# Hooks listen on 9000; only the runner's RPC port (8080) is ever put in auth
# tokens. /run must finish within 60 seconds, which covers the EFS mount.
HOOKS='{"port":9000,"microvmImageHooks":{"ready":"ENABLED","readyTimeoutInSeconds":600,"validate":"ENABLED","validateTimeoutInSeconds":600},"microvmHooks":{"run":"ENABLED","runTimeoutInSeconds":60,"resume":"ENABLED","resumeTimeoutInSeconds":30,"suspend":"ENABLED","suspendTimeoutInSeconds":30,"terminate":"ENABLED","terminateTimeoutInSeconds":15}}'

common_args=(
  --region "${REGION}"
  --code-artifact "uri=s3://${BUCKET}/${KEY}"
  --base-image-arn "${BASE_IMAGE_ARN}"
  --build-role-arn "${BUILD_ROLE}"
  --cpu-configurations architecture=ARM_64
  --resources "minimumMemoryInMiB=${MEMORY_MIB}"
  --additional-os-capabilities ALL
  --egress-network-connectors "${CONNECTOR_ARN}"
  --hooks "${HOOKS}"
  --logging "{\"cloudWatch\":{\"logGroup\":\"${LOG_GROUP}\"}}"
)

if aws lambda-microvms get-microvm-image --region "${REGION}" --image-identifier "${IMAGE_NAME}" >/dev/null 2>&1; then
  echo "Updating ${IMAGE_NAME} with a new version..."
  aws lambda-microvms update-microvm-image --image-identifier "${IMAGE_NAME}" "${common_args[@]}" >/dev/null
else
  echo "Creating ${IMAGE_NAME}..."
  aws lambda-microvms create-microvm-image --name "${IMAGE_NAME}" "${common_args[@]}" >/dev/null
fi

echo "Waiting for the build (the image is built, started, snapshotted, then validated)..."
for _ in $(seq 1 240); do
  read -r state arn <<<"$(aws lambda-microvms get-microvm-image --region "${REGION}" \
    --image-identifier "${IMAGE_NAME}" --query '[state, imageArn]' --output text)"
  case "${state}" in
    CREATED | UPDATED)
      echo "${arn}" > "${STATE_DIR}/microvm-image-arn"
      echo "Image ready: ${arn}"
      exit 0
      ;;
    CREATION_FAILED | UPDATE_FAILED)
      aws lambda-microvms get-microvm-image --region "${REGION}" --image-identifier "${IMAGE_NAME}"
      echo "Build logs: aws logs tail ${LOG_GROUP} --region ${REGION} --since 1h" >&2
      exit 1
      ;;
  esac
  sleep 15
done
echo "Timed out waiting for ${IMAGE_NAME}" >&2
exit 1
