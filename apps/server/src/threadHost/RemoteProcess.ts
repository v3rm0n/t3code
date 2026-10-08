/**
 * A process running in a thread's VM, driven from this server. Output is read
 * by attaching from the last byte offset received, so a dropped socket or a
 * suspended VM resumes where it stopped; only the runner's exit event ends the
 * process here. Writes are sent one at a time to keep stdin in order.
 */
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  THREAD_RUNNER_METHODS,
  type ThreadRunnerAttachEvent,
  ThreadRunnerError,
  type ThreadRunnerProcessInfo,
  type ThreadRunnerSpawnInput,
} from "@t3tools/contracts/threadRunner";

import type { RunnerClient } from "./runnerSocket.ts";
import { ThreadHostError } from "./ThreadHostError.ts";
import type { VmConnection } from "./VmConnection.ts";

export interface RemoteProcessExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/** Runs effects from callbacks that cannot be Effects themselves (SDK hooks, PTY events). */
export interface RemoteRuntime {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  readonly runFork: (effect: Effect.Effect<void>) => void;
}

/** A `RemoteRuntime` running in the calling fiber's context. */
export const makeRemoteRuntime = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  return {
    runPromise: (effect) => Effect.runPromiseWith(context)(effect),
    runFork: (effect) => {
      Effect.runForkWith(context)(effect);
    },
  } satisfies RemoteRuntime;
});

/** A runner request that failed; transport failures are retried after reconnecting. */
const MAX_REQUEST_ATTEMPTS = 3;

const isRunnerError = Schema.is(ThreadRunnerError);

/**
 * The runner's own refusal, as opposed to a transport problem. Closing a
 * socket interrupts its in-flight requests rather than failing them, so
 * anything that is not a runner error counts as transport and is retried.
 */
const runnerErrorIn = <E>(cause: Cause.Cause<E>): ThreadRunnerError | undefined =>
  Option.getOrUndefined(Option.filter(Cause.findErrorOption(cause), isRunnerError));

const reconnectDelay = (failures: number) =>
  Duration.millis(Math.min(10_000, 500 * 2 ** Math.min(failures, 5)));

export class RemoteProcess {
  readonly processId: string;
  readonly pty: boolean;
  readonly #spec: ThreadRunnerSpawnInput;
  readonly #connection: Effect.Effect<VmConnection, ThreadHostError>;
  readonly #runtime: RemoteRuntime;
  #resolved: VmConnection | null = null;
  #pid = -1;
  #offset = 0;
  #exit: RemoteProcessExit | null = null;
  #writes: Promise<void> = Promise.resolve();
  readonly #dataListeners = new Set<(data: Uint8Array, stream: "stdout" | "stderr") => void>();
  /** Output that arrived before anyone listened, such as a shell's first prompt. */
  #pendingData: Array<{ readonly data: Uint8Array; readonly stream: "stdout" | "stderr" }> = [];
  readonly #exitListeners = new Set<(exit: RemoteProcessExit) => void>();

  constructor(input: {
    readonly spec: ThreadRunnerSpawnInput;
    readonly connection: Effect.Effect<VmConnection, ThreadHostError>;
    readonly runtime: RemoteRuntime;
  }) {
    this.processId = input.spec.processId;
    this.pty = input.spec.pty !== undefined;
    this.#spec = input.spec;
    this.#connection = input.connection;
    this.#runtime = input.runtime;
  }

  /** The process id inside the VM; meaningless on this machine. */
  get pid(): number {
    return this.#pid;
  }

  get exit(): RemoteProcessExit | null {
    return this.#exit;
  }

  /** Spawns the process in the VM and starts streaming its output. */
  start(): Effect.Effect<ThreadRunnerProcessInfo, ThreadHostError> {
    const resolveConnection = this.#connection;
    return Effect.gen({ self: this }, function* () {
      const connection = yield* resolveConnection;
      this.#resolved = connection;
      const info = yield* this.#request(
        (client) => client[THREAD_RUNNER_METHODS.spawn](this.#spec),
        "spawn-failed",
      );
      this.#pid = info.pid;
      if (!this.pty) connection.retainPipe();
      this.#runtime.runFork(this.#pump(connection));
      return info;
    });
  }

  /**
   * Starts the process without waiting, for callers that need a handle
   * synchronously (the Claude SDK spawn hook). Writes made before the spawn
   * finishes are held until it does; a failed spawn ends the process.
   */
  begin(onFailure: (error: ThreadHostError) => void): void {
    const started = this.#runtime.runPromise(
      this.start().pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            onFailure(error);
            this.#finish({ exitCode: null, signal: null });
          }),
        ),
      ),
    );
    this.#writes = started.then(
      () => {},
      () => {},
    );
  }

  onData(listener: (data: Uint8Array, stream: "stdout" | "stderr") => void): () => void {
    this.#dataListeners.add(listener);
    if (this.#pendingData.length > 0) {
      const pending = this.#pendingData;
      this.#pendingData = [];
      queueMicrotask(() => {
        for (const chunk of pending) listener(chunk.data, chunk.stream);
      });
    }
    return () => this.#dataListeners.delete(listener);
  }

  onExit(listener: (exit: RemoteProcessExit) => void): () => void {
    if (this.#exit !== null) {
      const exit = this.#exit;
      queueMicrotask(() => listener(exit));
      return () => {};
    }
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  write(data: Uint8Array): Promise<void> {
    return this.#enqueue(() =>
      this.#request((client) =>
        client[THREAD_RUNNER_METHODS.write]({ processId: this.processId, data }),
      ),
    );
  }

  closeStdin(): Promise<void> {
    return this.#enqueue(() =>
      this.#request((client) =>
        client[THREAD_RUNNER_METHODS.closeStdin]({ processId: this.processId }),
      ),
    );
  }

  resize(cols: number, rows: number): Promise<void> {
    return this.#runIfRunning(
      this.#request((client) =>
        client[THREAD_RUNNER_METHODS.resize]({ processId: this.processId, cols, rows }),
      ),
    );
  }

  signal(signal: string): Promise<void> {
    return this.#runIfRunning(
      this.#request((client) =>
        client[THREAD_RUNNER_METHODS.signal]({ processId: this.processId, signal }),
      ),
    );
  }

  waitForExit(): Promise<RemoteProcessExit> {
    return new Promise((resolve) => {
      this.onExit(resolve);
    });
  }

  #runIfRunning(effect: Effect.Effect<void, ThreadHostError>): Promise<void> {
    if (this.#exit !== null || this.#resolved === null) return Promise.resolve();
    return this.#runtime.runPromise(effect);
  }

  #enqueue(next: () => Effect.Effect<void, ThreadHostError>): Promise<void> {
    const run = this.#writes.then(() => this.#runIfRunning(next()));
    // Later writes still go out if one fails; the caller sees its own failure.
    this.#writes = run.catch(() => {});
    return run;
  }

  /** A runner request on a connected client, reconnecting after transport failures. */
  #request<A, E>(
    use: (client: RunnerClient) => Effect.Effect<A, E>,
    reason: ThreadHostError["reason"] = "runner-request-failed",
  ): Effect.Effect<A, ThreadHostError> {
    const resolveConnection = this.#connection;
    return Effect.gen({ self: this }, function* () {
      const connection = this.#resolved ?? (yield* resolveConnection);
      let lastFailure: unknown = undefined;
      for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
        const client = yield* connection.client;
        const outcome = yield* use(client).pipe(Effect.exit);
        if (Exit.isSuccess(outcome)) return outcome.value;
        const runnerError = runnerErrorIn(outcome.cause);
        lastFailure = runnerError ?? Cause.squash(outcome.cause);
        if (runnerError !== undefined) break;
        yield* connection.invalidate(client);
        yield* Effect.sleep(reconnectDelay(attempt));
      }
      return yield* new ThreadHostError({
        reason,
        detail: `Runner request for ${this.processId} failed.`,
        cause: lastFailure,
      });
    });
  }

  #pump(connection: VmConnection): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      let failures = 0;
      while (this.#exit === null) {
        const clientResult = yield* connection.client.pipe(Effect.result);
        if (clientResult._tag === "Failure") {
          if (yield* connection.checkGone) {
            this.#finish({ exitCode: null, signal: "SIGKILL" });
            return;
          }
          yield* Effect.sleep(reconnectDelay(failures++));
          continue;
        }
        const client = clientResult.success;
        const outcome = yield* client[THREAD_RUNNER_METHODS.attach]({
          processId: this.processId,
          fromOffset: this.#offset,
        }).pipe(
          Stream.runForEach((event) => Effect.sync(() => this.#handle(event, connection))),
          Effect.exit,
        );
        if (this.#exit !== null) return;
        if (Exit.isFailure(outcome) && runnerErrorIn(outcome.cause) !== undefined) {
          // The runner no longer knows the process: the VM was replaced underneath it.
          this.#finish({ exitCode: null, signal: "SIGKILL" });
          return;
        }
        yield* connection.invalidate(client);
        yield* connection.awaitDemand;
        yield* Effect.sleep(reconnectDelay(failures++));
      }
    });
  }

  #handle(event: ThreadRunnerAttachEvent, connection: VmConnection): void {
    switch (event._tag) {
      case "Output":
        this.#offset = event.offset + event.data.byteLength;
        if (this.pty) connection.notePtyActivity();
        if (this.#dataListeners.size === 0) {
          this.#pendingData.push({ data: event.data, stream: event.stream });
          return;
        }
        for (const listener of this.#dataListeners) listener(event.data, event.stream);
        return;
      case "Gap":
        this.#offset = event.toOffset;
        return;
      case "Exit":
        this.#finish({ exitCode: event.exitCode, signal: event.signal });
        return;
    }
  }

  #finish(exit: RemoteProcessExit): void {
    if (this.#exit !== null) return;
    this.#exit = exit;
    if (!this.pty) this.#resolved?.releasePipe();
    for (const listener of this.#exitListeners) listener(exit);
    this.#exitListeners.clear();
    const connection = this.#resolved;
    if (connection !== null) {
      this.#runtime.runFork(
        connection.client.pipe(
          Effect.flatMap((client) =>
            client[THREAD_RUNNER_METHODS.release]({ processId: this.processId }),
          ),
          Effect.ignore,
        ),
      );
    }
  }
}
