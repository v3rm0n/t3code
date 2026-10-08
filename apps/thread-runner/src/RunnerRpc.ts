import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  THREAD_RUNNER_METHODS,
  type ThreadRunnerAttachEvent,
  ThreadRunnerError,
  ThreadRunnerRpcGroup,
  type ThreadRunnerStatus,
} from "@t3tools/contracts/threadRunner";

import { type ProcessTable, type RunnerProcess, UnknownSignalError } from "./ProcessTable.ts";
import type { RunnerState } from "./RunnerState.ts";

/** Caps one stream page so a large backlog goes out as several frames. */
const MAX_ATTACH_PAGE_BYTES = 256 * 1024;

export interface RunnerRpcDeps {
  readonly table: ProcessTable;
  readonly state: RunnerState;
  readonly runnerVersion: string;
}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const notFound = (processId: string) =>
  new ThreadRunnerError({ reason: "not-found", detail: `No process ${processId}.` });

const waitForChange = (entry: RunnerProcess, sinceVersion: number) =>
  Effect.callback<void>((resume) => {
    const cancel = entry.onceChanged(sinceVersion, () => resume(Effect.void));
    return Effect.sync(cancel);
  });

/** Next page of an attach stream: output from `cursor`, else the exit, else wait. */
const nextAttachPage = (
  entry: RunnerProcess,
  cursor: number,
): Effect.Effect<readonly [ReadonlyArray<ThreadRunnerAttachEvent>, Option.Option<number>]> =>
  Effect.suspend(() => {
    const version = entry.version;
    const read = entry.output.read(cursor);
    const events: Array<ThreadRunnerAttachEvent> = [];
    let next = cursor;
    if (read.gap) {
      events.push({ _tag: "Gap", fromOffset: read.gap.fromOffset, toOffset: read.gap.toOffset });
      next = read.gap.toOffset;
    }
    let pageBytes = 0;
    for (const chunk of read.chunks) {
      if (pageBytes > 0 && pageBytes + chunk.data.byteLength > MAX_ATTACH_PAGE_BYTES) break;
      events.push({ _tag: "Output", stream: chunk.stream, offset: chunk.offset, data: chunk.data });
      pageBytes += chunk.data.byteLength;
      next = chunk.offset + chunk.data.byteLength;
    }
    if (events.length > 0) return Effect.succeed([events, Option.some(next)] as const);
    const exit = entry.exit;
    if (exit !== null) {
      return Effect.succeed([[{ _tag: "Exit", ...exit }], Option.none<number>()] as const);
    }
    return waitForChange(entry, version).pipe(Effect.andThen(nextAttachPage(entry, cursor)));
  });

export const runnerStatus = (deps: RunnerRpcDeps): ThreadRunnerStatus => ({
  runnerVersion: deps.runnerVersion,
  microvmId: deps.state.microvmId,
  threadId: deps.state.payload?.threadId ?? null,
  startedAt: deps.state.startedAt,
  workspace: deps.state.workspace,
  docker: deps.state.docker,
  processes: deps.table.list().map((entry) => entry.info()),
});

export const makeRunnerRpcHandlers = (deps: RunnerRpcDeps) => {
  const withProcess = (processId: string, use: (entry: RunnerProcess) => void) =>
    Effect.suspend(() => {
      const entry = deps.table.get(processId);
      if (!entry) return Effect.fail(notFound(processId));
      return Effect.try({
        try: () => use(entry),
        catch: (cause) =>
          new ThreadRunnerError({
            reason: cause instanceof UnknownSignalError ? "invalid" : "not-running",
            detail: describe(cause),
          }),
      });
    });

  return ThreadRunnerRpcGroup.of({
    [THREAD_RUNNER_METHODS.status]: () => Effect.sync(() => runnerStatus(deps)),
    [THREAD_RUNNER_METHODS.spawn]: (input) =>
      Effect.tryPromise({
        try: () =>
          deps.table.spawn({
            processId: input.processId,
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            env: {
              ...deps.state.baseEnv(),
              ...(input.pty ? { TERM: "xterm-256color", COLORTERM: "truecolor" } : {}),
              ...input.env,
            },
            pty: input.pty,
          }),
        catch: (cause) =>
          new ThreadRunnerError({ reason: "spawn-failed", detail: describe(cause) }),
      }).pipe(Effect.map((entry) => entry.info())),
    [THREAD_RUNNER_METHODS.attach]: (input) =>
      Stream.suspend(() => {
        const entry = deps.table.get(input.processId);
        if (!entry) return Stream.fail(notFound(input.processId));
        return Stream.paginate(input.fromOffset, (cursor) => nextAttachPage(entry, cursor));
      }),
    [THREAD_RUNNER_METHODS.write]: (input) =>
      withProcess(input.processId, (entry) => entry.write(input.data)),
    [THREAD_RUNNER_METHODS.closeStdin]: (input) =>
      withProcess(input.processId, (entry) => entry.closeStdin()),
    [THREAD_RUNNER_METHODS.resize]: (input) =>
      withProcess(input.processId, (entry) => entry.resize(input.cols, input.rows)),
    [THREAD_RUNNER_METHODS.signal]: (input) =>
      withProcess(input.processId, (entry) => entry.signal(input.signal)),
    [THREAD_RUNNER_METHODS.release]: (input) =>
      Effect.sync(() => deps.table.release(input.processId)),
    [THREAD_RUNNER_METHODS.heartbeat]: () => Effect.void,
  });
};
