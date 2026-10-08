# MicroVM image for T3 thread runners: the runner, the provider CLIs, and the
# toolchains agents use. Lambda runs this Dockerfile on its AL2023 MicroVM base,
# starts the runner, and snapshots it after the runner's /ready hook answers.
# Everything unique to one VM (its secret, the workspace mount, dockerd, agent
# processes) starts later, in the runner's /run hook.
#
# Built from the artifact staged by `scripts/build-image-artifact.ts`, which
# places the bundled runner in ./runner next to this file.
FROM public.ecr.aws/lambda/microvms:al2023-minimal

ARG NODE_VERSION=24.19.0
ARG PNPM_VERSION=11.10.0
ARG CLAUDE_CODE_VERSION=2.1.293
ARG CODEX_VERSION=0.161.0
ARG RIPGREP_VERSION=15.2.0
ARG GH_VERSION=2.102.0

# curl-minimal ships with the base image and handles https; installing `curl`
# would conflict with it.
RUN dnf install -y --setopt=install_weak_deps=0 \
      amazon-efs-utils \
      bash ca-certificates diffutils docker e2fsprogs findutils gawk gcc gcc-c++ git gzip \
      hostname iproute iptables-nft java-21-amazon-corretto-devel jq make openssh-clients \
      patch procps-ng python3 shadow-utils tar unzip util-linux which xz \
  && dnf clean all \
  && rm -rf /var/cache/dnf

RUN curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz" \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
     | grep " node-v${NODE_VERSION}-linux-arm64.tar.xz\$" | sha256sum -c - \
  && tar -xJf "node-v${NODE_VERSION}-linux-arm64.tar.xz" -C /usr/local --strip-components=1 --no-same-owner \
  && rm "node-v${NODE_VERSION}-linux-arm64.tar.xz" \
  && node --version

RUN curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-aarch64-unknown-linux-gnu.tar.gz" \
     | tar -xz -C /usr/local/bin --strip-components=1 --wildcards '*/rg' \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_arm64.tar.gz" \
     | tar -xz -C /usr/local --strip-components=1 --wildcards '*/bin/gh' \
  && rg --version && gh --version

RUN npm install -g --no-audit --no-fund \
      "pnpm@${PNPM_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force \
  && claude --version && codex --version

# Agents, terminals, and setup scripts run as t3 (uid/gid 1000), the same
# identity the EFS access point enforces. Caches live on local disk: fast, and
# rebuilt whenever a thread gets a fresh VM.
RUN groupadd --gid 1000 t3 \
  && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash t3 \
  && mkdir -p /var/cache/t3 /t3/work \
  && chown t3:t3 /var/cache/t3

ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin \
    LANG=C.UTF-8 \
    JAVA_HOME=/usr/lib/jvm/java-21-amazon-corretto \
    GRADLE_USER_HOME=/var/cache/t3/gradle \
    npm_config_cache=/var/cache/t3/npm \
    XDG_CACHE_HOME=/var/cache/t3/cache \
    XDG_DATA_HOME=/var/cache/t3/share \
    DISABLE_AUTOUPDATER=1

COPY runner/ /opt/t3-runner/
COPY start-dockerd.sh /opt/t3-runner/start-dockerd.sh
RUN chmod +x /opt/t3-runner/start-dockerd.sh \
  && cd /opt/t3-runner \
  && npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force

WORKDIR /opt/t3-runner
EXPOSE 8080 9000
# Runs as root: it mounts the workspace and supervises dockerd. Children drop to t3.
ENTRYPOINT ["node", "/opt/t3-runner/main.mjs"]
