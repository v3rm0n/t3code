// @effect-diagnostics nodeBuiltinImport:off - adapts remote processes to Node stream interfaces.
/**
 * The shapes each consumer expects of a process, backed by a `RemoteProcess`:
 * a Node child process for the Claude Agent SDK, a PTY for the terminal
 * manager, and a byte `Stdio` for the Codex app-server client.
 */
import * as NodeOS from "node:os";
import * as NodeStream from "node:stream";

import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import type { PtyProcess } from "../terminal/PtyAdapter.ts";
import type { RemoteProcess } from "./RemoteProcess.ts";
import type { ThreadHostError } from "./ThreadHostError.ts";

const encoder = new TextEncoder();

const toBytes = (chunk: unknown): Uint8Array =>
  typeof chunk === "string"
    ? encoder.encode(chunk)
    : chunk instanceof Uint8Array
      ? chunk
      : encoder.encode(String(chunk));

const signalNumber = (signal: string | null): number | null => {
  if (signal === null) return null;
  const value = (NodeOS.constants.signals as Record<string, number | undefined>)[signal];
  return value ?? null;
};

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

/**
 * A Node child-process lookalike for the Agent SDK's `spawnClaudeCodeProcess`.
 * The SDK writes the control protocol to stdin and reads it from stdout.
 */
class SdkRemoteChild implements SpawnedProcess {
  readonly stdin: NodeStream.Writable;
  readonly stdout = new NodeStream.Readable({ read() {} });
  readonly #remote: RemoteProcess;
  readonly #exitListeners = new Map<ExitListener, boolean>();
  readonly #errorListeners = new Map<ErrorListener, boolean>();
  #killed = false;

  constructor(remote: RemoteProcess) {
    this.#remote = remote;
    this.stdin = new NodeStream.Writable({
      write(chunk, _encoding, callback) {
        remote.write(toBytes(chunk)).then(
          () => callback(),
          (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
        );
      },
      final(callback) {
        remote.closeStdin().then(
          () => callback(),
          (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
        );
      },
    });
    remote.onData((data, stream) => {
      if (stream === "stdout") this.stdout.push(Buffer.from(data));
    });
    remote.onExit((exit) => {
      this.stdout.push(null);
      this.#emit(this.#exitListeners, (listener) =>
        listener(exit.exitCode, exit.signal as NodeJS.Signals | null),
      );
    });
  }

  get killed(): boolean {
    return this.#killed;
  }

  get exitCode(): number | null {
    return this.#remote.exit?.exitCode ?? null;
  }

  get signalCode(): NodeJS.Signals | null {
    return (this.#remote.exit?.signal ?? null) as NodeJS.Signals | null;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.#killed = true;
    this.#remote.signal(signal).catch(() => {});
    return true;
  }

  on(event: "exit", listener: ExitListener): void;
  on(event: "error", listener: ErrorListener): void;
  on(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
    this.#add(event, listener, false);
  }

  once(event: "exit", listener: ExitListener): void;
  once(event: "error", listener: ErrorListener): void;
  once(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
    this.#add(event, listener, true);
  }

  off(event: "exit", listener: ExitListener): void;
  off(event: "error", listener: ErrorListener): void;
  off(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
    if (event === "exit") this.#exitListeners.delete(listener as ExitListener);
    else this.#errorListeners.delete(listener as ErrorListener);
  }

  /** Reports a spawn that never happened the way a failed `child_process.spawn` would. */
  fail(error: ThreadHostError): void {
    this.#emit(this.#errorListeners, (listener) => listener(error));
  }

  #add(event: "exit" | "error", listener: ExitListener | ErrorListener, once: boolean): void {
    if (event === "exit") this.#exitListeners.set(listener as ExitListener, once);
    else this.#errorListeners.set(listener as ErrorListener, once);
  }

  #emit<L>(listeners: Map<L, boolean>, call: (listener: L) => void): void {
    for (const [listener, once] of listeners) {
      if (once) listeners.delete(listener);
      call(listener);
    }
  }
}

export const sdkProcessView = (remote: RemoteProcess) => new SdkRemoteChild(remote);

let nextRemotePtyId = 1;

/**
 * A PTY lookalike for the terminal manager. Its pid is negative so the
 * manager's local process inspection never confuses it with a real process here.
 */
export const ptyProcessView = (remote: RemoteProcess): PtyProcess => {
  const pid = -(1_000_000 + nextRemotePtyId++);
  return {
    pid,
    write: (data) => {
      remote.write(encoder.encode(data)).catch(() => {});
    },
    resize: (cols, rows) => {
      remote.resize(cols, rows).catch(() => {});
    },
    kill: (signal) => {
      remote.signal(signal ?? "SIGHUP").catch(() => {});
    },
    onData: (callback) => {
      const decoder = new TextDecoder();
      return remote.onData((data) => callback(decoder.decode(data, { stream: true })));
    },
    onExit: (callback) =>
      remote.onExit((exit) =>
        // A signal exit has no code; NaN keeps the manager from inventing one.
        callback({ exitCode: exit.exitCode ?? Number.NaN, signal: signalNumber(exit.signal) }),
      ),
  };
};

/**
 * The byte streams the Codex app-server client speaks over. Created before
 * the process starts, so no output is missed.
 */
export const makeCodexStdio = (remote: RemoteProcess) =>
  Effect.gen(function* () {
    const output = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    remote.onData((data, stream) => {
      if (stream === "stdout") Queue.offerUnsafe(output, data);
    });
    remote.onExit(() => {
      Queue.endUnsafe(output);
    });
    return Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(output),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Effect.promise(() => remote.write(toBytes(chunk))),
        ),
      stderr: () => Sink.drain,
    });
  });
