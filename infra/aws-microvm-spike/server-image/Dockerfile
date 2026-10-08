# Tenant T3 server for Fargate (linux/arm64), run from source with Node's type
# stripping. Build from the repository root:
#
#   docker build --platform linux/arm64 -f infra/aws-microvm-spike/server-image/Dockerfile -t t3-server .
#
# Provider CLIs are installed here too: the server probes them, signs in with
# them, and generates commit messages and titles locally. Threads themselves
# run in MicroVMs.
FROM node:24.19.0-bookworm AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @t3tools/web build

FROM node:24.19.0-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.293
ARG CODEX_VERSION=0.161.0
ARG PNPM_VERSION=11.10.0
ARG GH_VERSION=2.102.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq openssh-client procps tini \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_arm64.tar.gz" \
     | tar -xz -C /usr/local --strip-components=1 --wildcards '*/bin/gh' \
  && npm install -g --no-audit --no-fund \
     "pnpm@${PNPM_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force

# The node image already has uid/gid 1000 ("node"); EFS access points enforce
# the same ids, so files agree with the thread VMs.
RUN mkdir -p /t3/state /t3/work && chown node:node /t3/state /t3/work
COPY --from=build --chown=node:node /src /opt/t3code
COPY --chmod=755 infra/aws-microvm-spike/server-image/entrypoint.sh /usr/local/bin/t3-entrypoint

ENV T3CODE_HOST=0.0.0.0 \
    T3CODE_PORT=3773 \
    T3CODE_HOME=/t3/state \
    DISABLE_AUTOUPDATER=1
USER node
WORKDIR /opt/t3code
EXPOSE 3773
ENTRYPOINT ["tini", "--", "t3-entrypoint"]
