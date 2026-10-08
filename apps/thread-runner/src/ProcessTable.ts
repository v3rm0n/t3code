// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - owns raw child processes and PTYs.
/**
 * The processes a runner owns. A process lives until it exits and is released,
 * independent of any client connection: output goes into a bounded
 * `OutputLog`, and clients attach to that log from an offset. Pipes back
 * provider processes; a PTY backs terminals and setup scripts.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import type {
  ThreadRunnerProcessExit,
  ThreadRunnerProcessInfo,
} from "@t3tools/contracts/threadRunner";

import { OutputLog } from "./OutputLog.ts";

type NodePtyModule = typeof import("node-pty");
type NodePty = import("node-pty").IPty;

/** How long a closed pipe process waits for its stdio to drain before it is final. */
const STDIO_DRAIN_GRACE_MS = 2_000;

export interface ProcessSpawnSpec {
  readonly processId: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly pty?: { readonly cols: number; readonly rows: number } | undefined;
}

export interface ProcessTableOptions {
  readonly outputBufferBytes: number;
  /** Spawned processes drop to this user when the runner runs as root. */
  readonly childUid?: number | undefined;
  readonly childGid?: number | undefined;
  /** Exited processes nobody released are forgotten after this long. */
  readonly exitedRetentionMs: number;
  readonly loadPty: () => NodePtyModule;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

export class ProcessSpawnError extends Error {
  override readonly name = "ProcessSpawnError";
}

export class UnknownSignalError extends Error {
  override readonly name = "UnknownSignalError";
}

const isSignalName = (signal: string): signal is NodeJS.Signals =>
  Object.hasOwn(NodeOS.constants.signals, signal);

const signalNameFromNumber = (signal: number | undefined | null): string | null => {
  if (signal === undefined || signal === null || signal === 0) return null;
  for (const [name, value] of Object.entries(NodeOS.constants.signals)) {
    if (value === signal) return name;
  }
  return String(signal);
};

/** Signals the process group first so tool subprocesses go down with the agent. */
const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Not a group leader, or already gone.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
};

interface ProcessBackend {
  readonly pid: number;
  write(data: Uint8Array): void;
  closeStdin(): void;
  resize(cols: number, rows: number): void;
}

export interface RunnerProcessIdentity {
  readonly processId: string;
  readonly command: string;
  readonly pty: boolean;
  readonly startedAt: number;
}

export class RunnerProcess {
  readonly processId: string;
  readonly command: string;
  readonly pty: boolean;
  readonly startedAt: number;
  readonly output: OutputLog;
  #exit: ThreadRunnerProcessExit | null = null;
  #exitedAt: number | null = null;
  #version = 0;
  readonly #listeners = new Set<() => void>();
  #backend: ProcessBackend | null = null;

  constructor(identity: RunnerProcessIdentity, outputBufferBytes: number) {
    this.processId = identity.processId;
    this.command = identity.command;
    this.pty = identity.pty;
    this.startedAt = identity.startedAt;
    this.output = new OutputLog(outputBufferBytes);
  }

  get pid(): number {
    return this.#backend?.pid ?? -1;
  }

  get exit(): ThreadRunnerProcessExit | null {
    return this.#exit;
  }

  get exitedAt(): number | null {
    return this.#exitedAt;
  }

  /** Increments on every output append and on exit; lets readers wait without missing wakeups. */
  get version(): number {
    return this.#version;
  }

  get hasListeners(): boolean {
    return this.#listeners.size > 0;
  }

  attachBackend(backend: ProcessBackend): void {
    this.#backend = backend;
  }

  /** Registers a change listener. Fires at most once per call; re-register to keep listening. */
  onceChanged(sinceVersion: number, listener: () => void): () => void {
    if (this.#version !== sinceVersion) {
      listener();
      return () => {};
    }
    const wrapped = () => {
      this.#listeners.delete(wrapped);
      listener();
    };
    this.#listeners.add(wrapped);
    return () => this.#listeners.delete(wrapped);
  }

  appendOutput(stream: "stdout" | "stderr", data: Uint8Array): void {
    if (data.byteLength === 0) return;
    this.output.append(stream, data);
    this.#notify();
  }

  markExited(exit: ThreadRunnerProcessExit): void {
    if (this.#exit !== null) return;
    this.#exit = exit;
    this.#exitedAt = Date.now();
    this.#notify();
  }

  write(data: Uint8Array): void {
    this.#requireRunning().write(data);
  }

  closeStdin(): void {
    this.#requireRunning().closeStdin();
  }

  resize(cols: number, rows: number): void {
    this.#requireRunning().resize(cols, rows);
  }

  signal(signal: string): void {
    if (!isSignalName(signal)) {
      throw new UnknownSignalError(`Unknown signal ${signal}.`);
    }
    if (this.#exit !== null || this.pid <= 0) return;
    signalGroup(this.pid, signal);
  }

  info(): ThreadRunnerProcessInfo {
    return {
      processId: this.processId,
      pid: this.pid,
      pty: this.pty,
      command: this.command,
      startedAt: this.startedAt,
      outputOffset: this.output.endOffset,
      exit: this.#exit,
    };
  }

  #requireRunning(): ProcessBackend {
    if (this.#exit !== null || this.#backend === null) {
      throw new ProcessSpawnError(`Process ${this.processId} is not running.`);
    }
    return this.#backend;
  }

  #notify(): void {
    this.#version += 1;
    // Listeners re-register while being notified; a snapshot keeps this loop finite.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }
}

export class ProcessTable {
  readonly #processes = new Map<string, RunnerProcess>();
  /** Spawns still waiting for the child to start, so a retry joins the first attempt. */
  readonly #pending = new Map<string, Promise<RunnerProcess>>();
  readonly #options: ProcessTableOptions;

  constructor(options: ProcessTableOptions) {
    this.#options = options;
  }

  get(processId: string): RunnerProcess | undefined {
    return this.#processes.get(processId);
  }

  list(): ReadonlyArray<RunnerProcess> {
    return [...this.#processes.values()];
  }

  /** Spawns a process, or returns the existing one when the id was already used. */
  spawn(spec: ProcessSpawnSpec): Promise<RunnerProcess> {
    const pending = this.#pending.get(spec.processId);
    if (pending) return pending;
    const existing = this.#processes.get(spec.processId);
    if (existing) return Promise.resolve(existing);
    const started = this.#start(spec).finally(() => this.#pending.delete(spec.processId));
    this.#pending.set(spec.processId, started);
    return started;
  }

  async #start(spec: ProcessSpawnSpec): Promise<RunnerProcess> {
    const entry = new RunnerProcess(
      {
        processId: spec.processId,
        command: spec.command,
        pty: spec.pty !== undefined,
        startedAt: Date.now(),
      },
      this.#options.outputBufferBytes,
    );
    this.#processes.set(spec.processId, entry);
    try {
      if (spec.pty) {
        this.#spawnPty(entry, spec, spec.pty);
      } else {
        await this.#spawnPipes(entry, spec);
      }
    } catch (cause) {
      this.#processes.delete(spec.processId);
      throw cause instanceof ProcessSpawnError
        ? cause
        : new ProcessSpawnError(
            `Failed to spawn ${spec.command}: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          );
    }
    this.#options.log("process spawned", {
      processId: spec.processId,
      command: spec.command,
      pid: entry.pid,
      pty: entry.pty,
    });
    return entry;
  }

  /** Forgets a process, killing its group first if it still runs. */
  release(processId: string): void {
    const entry = this.#processes.get(processId);
    if (!entry) return;
    if (entry.exit === null && entry.pid > 0) {
      signalGroup(entry.pid, "SIGKILL");
    }
    this.#processes.delete(processId);
  }

  /** Drops exited processes that nobody is reading and nobody released. */
  sweep(now: number): void {
    for (const entry of this.#processes.values()) {
      const exitedAt = entry.exitedAt;
      if (
        exitedAt !== null &&
        !entry.hasListeners &&
        now - exitedAt > this.#options.exitedRetentionMs
      ) {
        this.#processes.delete(entry.processId);
      }
    }
  }

  signalAll(signal: NodeJS.Signals): void {
    for (const entry of this.#processes.values()) {
      if (entry.exit === null && entry.pid > 0) signalGroup(entry.pid, signal);
    }
  }

  #identity() {
    return {
      ...(this.#options.childUid === undefined ? {} : { uid: this.#options.childUid }),
      ...(this.#options.childGid === undefined ? {} : { gid: this.#options.childGid }),
    };
  }

  #spawnPipes(entry: RunnerProcess, spec: ProcessSpawnSpec): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = NodeChildProcess.spawn(spec.command, [...spec.args], {
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
        env: { ...spec.env },
        // A new process group lets signals reach the agent's tool subprocesses.
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        ...this.#identity(),
      });
      let spawned = false;
      let pendingExit: ThreadRunnerProcessExit | null = null;
      let drainTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (drainTimer !== null) clearTimeout(drainTimer);
        entry.markExited(pendingExit ?? { exitCode: null, signal: null });
      };

      child.once("spawn", () => {
        spawned = true;
        entry.attachBackend({
          pid: child.pid ?? -1,
          write: (data) => {
            child.stdin.write(data);
          },
          closeStdin: () => {
            child.stdin.end();
          },
          resize: () => {},
        });
        resolve();
      });
      child.once("error", (error) => {
        if (!spawned) {
          reject(new ProcessSpawnError(`Failed to spawn ${spec.command}: ${error.message}`));
          return;
        }
        this.#options.log("process error", { processId: spec.processId, error: error.message });
      });
      // Writes after the child closed its stdin are expected during shutdown.
      child.stdin.on("error", () => {});
      child.stdout.on("data", (chunk: Buffer) =>
        entry.appendOutput("stdout", Uint8Array.from(chunk)),
      );
      child.stderr.on("data", (chunk: Buffer) =>
        entry.appendOutput("stderr", Uint8Array.from(chunk)),
      );
      child.once("exit", (code, signal) => {
        pendingExit = { exitCode: code, signal };
        // A grandchild that inherited stdout can hold `close` open indefinitely.
        drainTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish();
        }, STDIO_DRAIN_GRACE_MS);
        drainTimer.unref();
        this.#options.log("process exited", {
          processId: spec.processId,
          exitCode: code,
          signal,
        });
      });
      child.once("close", (code, signal) => {
        pendingExit ??= { exitCode: code, signal };
        finish();
      });
    });
  }

  #spawnPty(
    entry: RunnerProcess,
    spec: ProcessSpawnSpec,
    size: { readonly cols: number; readonly rows: number },
  ): void {
    const ptyModule = this.#options.loadPty();
    const pty: NodePty = ptyModule.spawn(spec.command, [...spec.args], {
      name: spec.env.TERM ?? "xterm-256color",
      cols: size.cols,
      rows: size.rows,
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      env: { ...spec.env },
      ...this.#identity(),
    });
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    entry.attachBackend({
      pid: pty.pid,
      // Clients send bytes; a streaming decoder keeps split UTF-8 sequences intact.
      write: (data) => pty.write(decoder.decode(data, { stream: true })),
      closeStdin: () => pty.write("\u0004"),
      resize: (cols, rows) => pty.resize(cols, rows),
    });
    pty.onData((data) => entry.appendOutput("stdout", encoder.encode(data)));
    pty.onExit(({ exitCode, signal }) => {
      entry.markExited({ exitCode, signal: signalNameFromNumber(signal) });
      this.#options.log("process exited", { processId: spec.processId, exitCode, signal });
    });
  }
}
