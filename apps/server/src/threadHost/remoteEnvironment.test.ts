import { assert, describe, it } from "@effect/vitest";

import { remoteClaudeLaunch } from "./remoteClaudeSpawn.ts";
import { isUnderDirectory, remoteEnvironment } from "./remoteEnvironment.ts";

describe("remoteEnvironment", () => {
  it("drops what describes this server and keeps what the provider needs", () => {
    const env = remoteEnvironment(
      {
        PATH: "/usr/local/bin:/usr/bin",
        HOME: "/t3/work/home",
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/abc",
        ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4/abc",
        T3CODE_HOME: "/t3/state",
        T3CODE_MICROVM_IMAGE_ARN: "arn:aws:lambda:eu-central-1:1:microvm-image:t",
        npm_config_cache: "/root/.npm",
        ANTHROPIC_API_KEY: "sk-ant-test",
        OPENAI_API_KEY: "sk-test",
        CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
        T3CODE_PROJECT_ROOT: "/t3/work/projects/app",
        UNSET: undefined,
      },
      "/t3/work",
    );
    assert.deepStrictEqual(env, {
      ANTHROPIC_API_KEY: "sk-ant-test",
      OPENAI_API_KEY: "sk-test",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      T3CODE_PROJECT_ROOT: "/t3/work/projects/app",
    });
  });

  it("keeps a provider home only when the VM can see it", () => {
    assert.deepStrictEqual(
      remoteEnvironment(
        { CLAUDE_CONFIG_DIR: "/t3/work/home/.claude-work", CODEX_HOME: "/t3/state/codex" },
        "/t3/work/",
      ),
      { CLAUDE_CONFIG_DIR: "/t3/work/home/.claude-work" },
    );
  });

  it("matches directories, not string prefixes", () => {
    assert.isTrue(isUnderDirectory("/t3/work", "/t3/work"));
    assert.isTrue(isUnderDirectory("/t3/work/projects/app", "/t3/work"));
    assert.isFalse(isUnderDirectory("/t3/workspace", "/t3/work"));
  });
});

describe("remoteClaudeLaunch", () => {
  it("runs the VM's claude in place of a server-side node script", () => {
    assert.deepStrictEqual(
      remoteClaudeLaunch(
        {
          command: "/usr/local/bin/node",
          args: ["/app/node_modules/cli.js", "--output-format", "stream-json"],
        },
        "claude",
      ),
      { command: "claude", args: ["--output-format", "stream-json"] },
    );
  });

  it("keeps the arguments of a native binary", () => {
    assert.deepStrictEqual(
      remoteClaudeLaunch(
        { command: "/home/me/.local/bin/claude", args: ["--resume", "abc"] },
        "claude",
      ),
      { command: "claude", args: ["--resume", "abc"] },
    );
  });
});
