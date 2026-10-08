// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - supervises the dockerd process directly.
/**
 * Starts the Docker daemon inside the VM after `/run`, in the background so a
 * slow daemon never delays the VM accepting work. Docker inside a MicroVM's
 * container is unproven, so the start script degrades in steps (see
 * `image/start-dockerd.sh`) and the outcome is reported in runner status.
 */
import * as NodeChildProcess from "node:child_process";

import { runCommand } from "./command.ts";
import type { RunnerState } from "./RunnerState.ts";

const READY_TIMEOUT_MS = 60_000;
const OUTPUT_TAIL_LINES = 40;

/** Tried in order; later attempts trade networking features for a daemon that starts. */
const ATTEMPTS: ReadonlyArray<{ readonly label: string; readonly args: ReadonlyArray<string> }> = [
  { label: "default", args: [] },
  { label: "no-iptables", args: ["--iptables=false", "--ip6tables=false", "--bridge=none"] },
];

const dockerResponds = async () =>
  (await runCommand("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 5_000 }))
    .exitCode === 0;

export interface DockerDaemonOptions {
  readonly startScript: string;
  /** Group that owns the Docker socket; the child user's primary group. */
  readonly socketGroup: string;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

export class DockerDaemon {
  readonly #state: RunnerState;
  readonly #options: DockerDaemonOptions;
  #child: NodeChildProcess.ChildProcess | null = null;
  #starting = false;

  constructor(state: RunnerState, options: DockerDaemonOptions) {
    this.#state = state;
    this.#options = options;
  }

  start(): void {
    if (this.#starting) return;
    this.#starting = true;
    this.#state.docker = { state: "starting", detail: null };
    void this.#startWithFallbacks().finally(() => {
      this.#starting = false;
    });
  }

  /** After a resume the daemon normally survives; restart it only if it stopped answering. */
  async ensureRunning(): Promise<void> {
    if (this.#state.docker.state !== "ready") return;
    if (await dockerResponds()) return;
    this.#options.log("docker stopped responding after resume; restarting");
    this.stop();
    this.start();
  }

  stop(): void {
    this.#child?.kill("SIGTERM");
    this.#child = null;
  }

  async #startWithFallbacks(): Promise<void> {
    let lastOutput = "";
    for (const attempt of ATTEMPTS) {
      const outcome = await this.#attempt(attempt.args);
      if (outcome.ready) {
        this.#state.docker = { state: "ready", detail: attempt.label };
        this.#options.log("docker ready", { mode: attempt.label });
        return;
      }
      lastOutput = outcome.output;
      this.#options.log("docker attempt failed", { mode: attempt.label, output: outcome.output });
    }
    this.#state.docker = { state: "failed", detail: lastOutput.slice(-4_000) };
  }

  #attempt(extraArgs: ReadonlyArray<string>): Promise<{ ready: boolean; output: string }> {
    return new Promise((resolve) => {
      const lines: Array<string> = [];
      const remember = (chunk: Buffer) => {
        lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
        lines.splice(0, Math.max(0, lines.length - OUTPUT_TAIL_LINES));
      };
      const child = NodeChildProcess.spawn(
        this.#options.startScript,
        ["--group", this.#options.socketGroup, ...extraArgs],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      this.#child = child;
      child.stdout.on("data", remember);
      child.stderr.on("data", remember);

      let settled = false;
      const settle = (ready: boolean) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(deadline);
        if (!ready) {
          child.kill("SIGKILL");
          if (this.#child === child) this.#child = null;
        }
        resolve({ ready, output: lines.join("\n") });
      };
      child.once("exit", () => settle(false));
      child.once("error", (error) => {
        lines.push(error.message);
        settle(false);
      });
      const poll = setInterval(() => {
        void dockerResponds().then((ready) => {
          if (ready) settle(true);
        });
      }, 1_000);
      const deadline = setTimeout(() => settle(false), READY_TIMEOUT_MS);
    });
  }
}
