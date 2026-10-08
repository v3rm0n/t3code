// @effect-diagnostics globalDate:off - plain state object read by hooks and RPC handlers.
import type { ThreadRunnerRunPayload } from "@t3tools/contracts/threadRunner";

import type { RunnerConfig } from "./config.ts";

export type WorkspaceState = "unconfigured" | "mounted" | "failed";
export type DockerState = "disabled" | "starting" | "ready" | "failed";

/** Process environment variables that configure the runner itself and must not leak to children. */
const RUNNER_ENV_PREFIX = "T3_RUNNER_";

/**
 * What the runner learned from its `/run` hook, plus the health of what it set
 * up. Before `/run` arrives the runner accepts no RPC connections.
 */
export class RunnerState {
  readonly startedAt = Date.now();
  microvmId: string | null = null;
  payload: ThreadRunnerRunPayload | null = null;
  workspace: { state: WorkspaceState; detail: string | null } = {
    state: "unconfigured",
    detail: null,
  };
  docker: { state: DockerState; detail: string | null } = { state: "disabled", detail: null };

  readonly #config: RunnerConfig;

  constructor(config: RunnerConfig) {
    this.#config = config;
  }

  get secret(): string | null {
    return this.payload?.runnerSecret ?? null;
  }

  /** Environment every spawned process starts from, before per-spawn variables. */
  baseEnv(): Record<string, string> {
    const inherited: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith(RUNNER_ENV_PREFIX)) inherited[key] = value;
    }
    const home = this.payload?.home ?? `/home/${this.#config.childUser}`;
    return {
      ...inherited,
      HOME: home,
      USER: this.#config.childUser,
      LOGNAME: this.#config.childUser,
      SHELL: inherited.SHELL ?? "/bin/bash",
      LANG: inherited.LANG ?? "C.UTF-8",
      ...this.payload?.env,
    };
  }
}
