import * as Schema from "effect/Schema";

import {
  THREAD_RUNNER_HOOK_PORT,
  THREAD_RUNNER_RPC_PORT,
  ThreadRunnerRunPayload,
} from "@t3tools/contracts/threadRunner";

export interface RunnerConfig {
  readonly host: string;
  readonly rpcPort: number;
  readonly hookPort: number;
  readonly outputBufferBytes: number;
  readonly exitedRetentionMs: number;
  readonly childUid: number | undefined;
  readonly childGid: number | undefined;
  readonly childUser: string;
  readonly dockerStartScript: string;
  readonly efsUtilsConfigPath: string;
  /**
   * Applied at startup as if Lambda had called `/run`. Lets the runner work in a
   * plain container for local development, where no lifecycle hooks arrive.
   */
  readonly devPayload: ThreadRunnerRunPayload | undefined;
}

const decodeRunPayload = Schema.decodeUnknownSync(Schema.fromJsonString(ThreadRunnerRunPayload));

const intFromEnv = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Expected an integer, got "${value}".`);
  return parsed;
};

const optionalIntFromEnv = (value: string | undefined): number | undefined =>
  value === undefined || value.trim() === "" ? undefined : intFromEnv(value, 0);

export const readRunnerConfig = (env: NodeJS.ProcessEnv): RunnerConfig => {
  const runsAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
  return {
    host: env.T3_RUNNER_HOST ?? "0.0.0.0",
    rpcPort: intFromEnv(env.T3_RUNNER_RPC_PORT, THREAD_RUNNER_RPC_PORT),
    hookPort: intFromEnv(env.T3_RUNNER_HOOK_PORT, THREAD_RUNNER_HOOK_PORT),
    outputBufferBytes: intFromEnv(env.T3_RUNNER_OUTPUT_BUFFER_BYTES, 8 * 1024 * 1024),
    exitedRetentionMs: intFromEnv(env.T3_RUNNER_EXITED_RETENTION_MS, 15 * 60 * 1000),
    // Agents refuse some modes as root, so children drop to the image's t3 user.
    childUid: optionalIntFromEnv(env.T3_RUNNER_CHILD_UID) ?? (runsAsRoot ? 1000 : undefined),
    childGid: optionalIntFromEnv(env.T3_RUNNER_CHILD_GID) ?? (runsAsRoot ? 1000 : undefined),
    childUser: env.T3_RUNNER_CHILD_USER ?? "t3",
    dockerStartScript: env.T3_RUNNER_DOCKER_START ?? "/opt/t3-runner/start-dockerd.sh",
    efsUtilsConfigPath: env.T3_RUNNER_EFS_UTILS_CONFIG ?? "/etc/amazon/efs/efs-utils.conf",
    devPayload:
      env.T3_RUNNER_DEV_PAYLOAD === undefined || env.T3_RUNNER_DEV_PAYLOAD.trim() === ""
        ? undefined
        : decodeRunPayload(env.T3_RUNNER_DEV_PAYLOAD),
  };
};
