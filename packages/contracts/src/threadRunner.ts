/**
 * Wire protocol between a T3 server and the thread runner, the small daemon that
 * runs a thread's provider processes, terminals, and setup scripts inside a
 * remote VM (a Lambda MicroVM). Processes belong to the runner, not to a
 * connection: a client that reconnects attaches again from the last output
 * offset it saw, so a dropped socket or a suspended VM never ends a process.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Port of the runner's RPC WebSocket, the only port VM auth tokens should allow. */
export const THREAD_RUNNER_RPC_PORT = 8080;
/** Port Lambda calls lifecycle hooks on. Never reachable through the VM endpoint. */
export const THREAD_RUNNER_HOOK_PORT = 9000;
export const THREAD_RUNNER_RPC_PATH = "/rpc";
/** Upgrade header carrying the per-VM secret delivered in the run payload. */
export const THREAD_RUNNER_SECRET_HEADER = "x-t3-runner-secret";

/**
 * Per-VM configuration, sent by the server as Lambda's `runHookPayload` and
 * delivered to the runner's `/run` hook.
 */
export const ThreadRunnerRunPayload = Schema.Struct({
  version: Schema.Literal(1),
  runnerSecret: Schema.String.check(Schema.isMinLength(32)),
  tenantId: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(TrimmedNonEmptyString),
  /** Shared workspace mount, at the same path the server sees it. */
  workspace: Schema.optional(
    Schema.Struct({
      fileSystemId: TrimmedNonEmptyString,
      accessPointId: TrimmedNonEmptyString,
      mountPath: TrimmedNonEmptyString,
      region: Schema.optional(TrimmedNonEmptyString),
      /** Used when the file system's DNS name does not resolve from the VM. */
      mountTargetIp: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  /** HOME for spawned processes; on the shared mount so provider logins carry over. */
  home: Schema.optional(TrimmedNonEmptyString),
  docker: Schema.optional(Schema.Boolean),
  /** Extra environment applied to every spawned process, below per-spawn env. */
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type ThreadRunnerRunPayload = typeof ThreadRunnerRunPayload.Type;

export const ThreadRunnerProcessId = TrimmedNonEmptyString;

export const ThreadRunnerPtySize = Schema.Struct({
  cols: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  rows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export const ThreadRunnerSpawnInput = Schema.Struct({
  /** Chosen by the client so a retried spawn returns the existing process. */
  processId: ThreadRunnerProcessId,
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  /** Present for terminals: the process gets a PTY instead of pipes. */
  pty: Schema.optional(ThreadRunnerPtySize),
});
export type ThreadRunnerSpawnInput = typeof ThreadRunnerSpawnInput.Type;

export const ThreadRunnerProcessExit = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
});
export type ThreadRunnerProcessExit = typeof ThreadRunnerProcessExit.Type;

export const ThreadRunnerProcessInfo = Schema.Struct({
  processId: ThreadRunnerProcessId,
  pid: Schema.Int,
  pty: Schema.Boolean,
  command: Schema.String,
  startedAt: Schema.Number,
  /** Total bytes of output produced so far; where a fresh attach would end. */
  outputOffset: Schema.Number,
  exit: Schema.NullOr(ThreadRunnerProcessExit),
});
export type ThreadRunnerProcessInfo = typeof ThreadRunnerProcessInfo.Type;

export const ThreadRunnerAttachInput = Schema.Struct({
  processId: ThreadRunnerProcessId,
  /** Byte offset into the process's combined output. */
  fromOffset: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const ThreadRunnerOutputEvent = Schema.TaggedStruct("Output", {
  stream: Schema.Literals(["stdout", "stderr"]),
  offset: Schema.Number,
  data: Schema.Uint8ArrayFromBase64,
});
/** Output the runner no longer holds; its buffer is bounded per process. */
export const ThreadRunnerGapEvent = Schema.TaggedStruct("Gap", {
  fromOffset: Schema.Number,
  toOffset: Schema.Number,
});
/** Always the last event of an attach stream, after all output. */
export const ThreadRunnerExitEvent = Schema.TaggedStruct("Exit", {
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
});
export const ThreadRunnerAttachEvent = Schema.Union([
  ThreadRunnerOutputEvent,
  ThreadRunnerGapEvent,
  ThreadRunnerExitEvent,
]);
export type ThreadRunnerAttachEvent = typeof ThreadRunnerAttachEvent.Type;

export const ThreadRunnerProcessRef = Schema.Struct({ processId: ThreadRunnerProcessId });

export const ThreadRunnerWriteInput = Schema.Struct({
  processId: ThreadRunnerProcessId,
  data: Schema.Uint8ArrayFromBase64,
});

export const ThreadRunnerResizeInput = Schema.Struct({
  processId: ThreadRunnerProcessId,
  cols: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  rows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export const ThreadRunnerSignalInput = Schema.Struct({
  processId: ThreadRunnerProcessId,
  signal: TrimmedNonEmptyString,
});

const ThreadRunnerComponentStatus = <const States extends ReadonlyArray<string>>(states: States) =>
  Schema.Struct({
    state: Schema.Literals(states),
    detail: Schema.NullOr(Schema.String),
  });

export const ThreadRunnerStatus = Schema.Struct({
  runnerVersion: Schema.String,
  microvmId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  startedAt: Schema.Number,
  workspace: ThreadRunnerComponentStatus(["unconfigured", "mounted", "failed"]),
  docker: ThreadRunnerComponentStatus(["disabled", "starting", "ready", "failed"]),
  processes: Schema.Array(ThreadRunnerProcessInfo),
});
export type ThreadRunnerStatus = typeof ThreadRunnerStatus.Type;

export const ThreadRunnerErrorReason = Schema.Literals([
  "not-configured",
  "not-found",
  "spawn-failed",
  "not-running",
  "invalid",
]);
export type ThreadRunnerErrorReason = typeof ThreadRunnerErrorReason.Type;

export class ThreadRunnerError extends Schema.TaggedError<ThreadRunnerError>()(
  "ThreadRunnerError",
  {
    reason: ThreadRunnerErrorReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Thread runner ${this.reason}: ${this.detail}`;
  }
}

export const THREAD_RUNNER_METHODS = {
  status: "runner.status",
  spawn: "runner.spawn",
  attach: "runner.attach",
  write: "runner.write",
  closeStdin: "runner.closeStdin",
  resize: "runner.resize",
  signal: "runner.signal",
  release: "runner.release",
  heartbeat: "runner.heartbeat",
} as const;

export const ThreadRunnerRpcGroup = RpcGroup.make(
  Rpc.make(THREAD_RUNNER_METHODS.status, {
    success: ThreadRunnerStatus,
  }),
  Rpc.make(THREAD_RUNNER_METHODS.spawn, {
    payload: ThreadRunnerSpawnInput,
    success: ThreadRunnerProcessInfo,
    error: ThreadRunnerError,
  }),
  Rpc.make(THREAD_RUNNER_METHODS.attach, {
    payload: ThreadRunnerAttachInput,
    success: ThreadRunnerAttachEvent,
    error: ThreadRunnerError,
    stream: true,
  }),
  Rpc.make(THREAD_RUNNER_METHODS.write, {
    payload: ThreadRunnerWriteInput,
    error: ThreadRunnerError,
  }),
  Rpc.make(THREAD_RUNNER_METHODS.closeStdin, {
    payload: ThreadRunnerProcessRef,
    error: ThreadRunnerError,
  }),
  Rpc.make(THREAD_RUNNER_METHODS.resize, {
    payload: ThreadRunnerResizeInput,
    error: ThreadRunnerError,
  }),
  Rpc.make(THREAD_RUNNER_METHODS.signal, {
    payload: ThreadRunnerSignalInput,
    error: ThreadRunnerError,
  }),
  /** Forgets a process, killing it first if it is still running. */
  Rpc.make(THREAD_RUNNER_METHODS.release, {
    payload: ThreadRunnerProcessRef,
  }),
  /** Keeps endpoint traffic flowing so the VM's idle policy does not suspend it. */
  Rpc.make(THREAD_RUNNER_METHODS.heartbeat, {}),
);
