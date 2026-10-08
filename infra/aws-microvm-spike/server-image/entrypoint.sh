#!/bin/sh
# Starts the T3 server. When threads run in MicroVMs, providers there reach
# this server's MCP endpoint at the task's private address, which only ECS
# knows at runtime.
set -eu

if [ -z "${T3CODE_MCP_ADVERTISED_URL:-}" ] && [ -n "${ECS_CONTAINER_METADATA_URI_V4:-}" ]; then
  task_ip="$(curl -fsS "${ECS_CONTAINER_METADATA_URI_V4}/task" | jq -r '.Containers[0].Networks[0].IPv4Addresses[0]')"
  export T3CODE_MCP_ADVERTISED_URL="http://${task_ip}:${T3CODE_PORT:-3773}/mcp"
fi

mkdir -p "${HOME:-/t3/work/home}"
exec node /opt/t3code/apps/server/src/bin.ts serve "$@"
