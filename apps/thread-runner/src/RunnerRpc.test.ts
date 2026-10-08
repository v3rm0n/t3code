// @effect-diagnostics nodeBuiltinImport:off - loads node-pty the same way main.ts does.
import * as NodeModule from "node:module";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { RpcTest } from "effect/rpc";

import {
  THREAD_RUNNER_METHODS,
  type ThreadRunnerAttachEvent,
  ThreadRunnerRpcGroup,
} from "@t3tools/contracts/threadRunner";

import { readRunnerConfig } from "./config.ts";
import { ProcessTable } from "./ProcessTable.ts";
import { makeRunnerRpcHandlers } from "./RunnerRpc.ts";
import { RunnerState } from "./RunnerState.ts";

const requireForNodePty = NodeModule.createRequire(import.meta.url);

const makeHandlersLayer = () => {
  const config = readRunnerConfig({});
  const table = new ProcessTable({
    outputBufferBytes: 1024 * 1024,
    childUid: undefined,
    childGid: undefined,
    exitedRetentionMs: 60_000,
    loadPty: () => requireForNodePty("node-pty") as typeof import("node-pty"),
    log: () => {},
  });
  return ThreadRunnerRpcGroup.toLayer(
    makeRunnerRpcHandlers({ table, state: new RunnerState(config), runnerVersion: "test" }),
  );
};

const outputText = (events: ReadonlyArray<ThreadRunnerAttachEvent>) =>
  events
    .flatMap((event) => (event._tag === "Output" ? [new TextDecoder().decode(event.data)] : []))
    .join("");

const lastEvent = (events: ReadonlyArray<ThreadRunnerAttachEvent>) => events[events.length - 1];

const makeClient = RpcTest.makeClient(ThreadRunnerRpcGroup);

const withClient = <A, E>(
  use: (client: Effect.Success<typeof makeClient>) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* makeClient);
  }).pipe(Effect.scoped, Effect.provide(makeHandlersLayer()));

describe("thread runner RPC", () => {
  it.effect("streams output then exit, and a reattach resumes from an offset", () =>
    withClient((client) =>
      Effect.gen(function* () {
        yield* client[THREAD_RUNNER_METHODS.spawn]({
          processId: "echo",
          command: "/bin/sh",
          args: ["-c", "printf one; sleep 0.2; printf two"],
          env: {},
        });
        const first = yield* Stream.runCollect(
          client[THREAD_RUNNER_METHODS.attach]({ processId: "echo", fromOffset: 0 }),
        );
        assert.strictEqual(outputText(first), "onetwo");
        assert.deepStrictEqual(lastEvent(first), { _tag: "Exit", exitCode: 0, signal: null });

        const resumed = yield* Stream.runCollect(
          client[THREAD_RUNNER_METHODS.attach]({ processId: "echo", fromOffset: 3 }),
        );
        assert.strictEqual(outputText(resumed), "two");
        assert.strictEqual(lastEvent(resumed)?._tag, "Exit");
      }),
    ),
  );

  it.effect("forwards stdin and ends the process when stdin closes", () =>
    withClient((client) =>
      Effect.gen(function* () {
        yield* client[THREAD_RUNNER_METHODS.spawn]({
          processId: "cat",
          command: "cat",
          args: [],
          env: {},
        });
        const reader = yield* Stream.runCollect(
          client[THREAD_RUNNER_METHODS.attach]({ processId: "cat", fromOffset: 0 }),
        ).pipe(Effect.forkChild);
        yield* client[THREAD_RUNNER_METHODS.write]({
          processId: "cat",
          data: new TextEncoder().encode("hello runner\n"),
        });
        yield* client[THREAD_RUNNER_METHODS.closeStdin]({ processId: "cat" });
        const events = yield* Fiber.join(reader);
        assert.strictEqual(outputText(events), "hello runner\n");
        assert.deepStrictEqual(lastEvent(events), { _tag: "Exit", exitCode: 0, signal: null });
      }),
    ),
  );

  it.effect("signals the whole process group", () =>
    withClient((client) =>
      Effect.gen(function* () {
        yield* client[THREAD_RUNNER_METHODS.spawn]({
          processId: "group",
          command: "/bin/sh",
          args: ["-c", "sleep 30 & wait"],
          env: {},
        });
        yield* client[THREAD_RUNNER_METHODS.signal]({ processId: "group", signal: "SIGTERM" });
        const events = yield* Stream.runCollect(
          client[THREAD_RUNNER_METHODS.attach]({ processId: "group", fromOffset: 0 }),
        );
        assert.deepStrictEqual(lastEvent(events), {
          _tag: "Exit",
          exitCode: null,
          signal: "SIGTERM",
        });
      }),
    ),
  );

  it.effect("runs terminals in a PTY", () =>
    withClient((client) =>
      Effect.gen(function* () {
        const info = yield* client[THREAD_RUNNER_METHODS.spawn]({
          processId: "pty",
          command: "/bin/sh",
          args: ["-c", "printf pty-ok"],
          env: {},
          pty: { cols: 80, rows: 24 },
        });
        assert.isTrue(info.pty);
        const events = yield* Stream.runCollect(
          client[THREAD_RUNNER_METHODS.attach]({ processId: "pty", fromOffset: 0 }),
        );
        assert.include(outputText(events), "pty-ok");
        assert.deepStrictEqual(lastEvent(events), { _tag: "Exit", exitCode: 0, signal: null });
      }),
    ),
  );

  it.effect("returns the existing process when a spawn is retried", () =>
    withClient((client) =>
      Effect.gen(function* () {
        const spec = { processId: "retry", command: "sleep", args: ["5"], env: {} };
        const first = yield* client[THREAD_RUNNER_METHODS.spawn](spec);
        const second = yield* client[THREAD_RUNNER_METHODS.spawn](spec);
        assert.strictEqual(second.pid, first.pid);
        yield* client[THREAD_RUNNER_METHODS.release]({ processId: "retry" });
        const status = yield* client[THREAD_RUNNER_METHODS.status]();
        assert.deepStrictEqual(status.processes, []);
      }),
    ),
  );

  it.effect("reports unknown processes and commands that cannot start", () =>
    withClient((client) =>
      Effect.gen(function* () {
        const missing = yield* Stream.runCollect(
          client[THREAD_RUNNER_METHODS.attach]({ processId: "nope", fromOffset: 0 }),
        ).pipe(Effect.flip);
        assert.strictEqual(missing.reason, "not-found");

        const failed = yield* client[THREAD_RUNNER_METHODS.spawn]({
          processId: "missing-binary",
          command: "/definitely/not/a/binary",
          args: [],
          env: {},
        }).pipe(Effect.flip);
        assert.strictEqual(failed.reason, "spawn-failed");
      }),
    ),
  );
});
