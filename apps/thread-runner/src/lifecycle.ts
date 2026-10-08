// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - drives mount, sync, and process shutdown directly.
/**
 * Handlers for Lambda's MicroVM lifecycle hooks. The image snapshot is taken
 * after `/ready`, so everything unique to one VM (its secret, its workspace
 * mount, the Docker daemon, every agent process) starts in `/run` or later.
 */
import * as NodeFSP from "node:fs/promises";

import type { ThreadRunnerRunPayload } from "@t3tools/contracts/threadRunner";

import { runCommand } from "./command.ts";
import type { RunnerConfig } from "./config.ts";
import type { DockerDaemon } from "./docker.ts";
import type { ProcessTable, RunnerProcess } from "./ProcessTable.ts";
import type { RunnerState } from "./RunnerState.ts";
import { checkWorkspace, isMounted, mountWorkspace } from "./workspaceMount.ts";

export interface LifecycleDeps {
  readonly config: RunnerConfig;
  readonly state: RunnerState;
  readonly table: ProcessTable;
  readonly docker: DockerDaemon;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const waitForExit = (entry: RunnerProcess, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    let cancel = () => {};
    const timer = setTimeout(() => {
      cancel();
      resolve(false);
    }, timeoutMs);
    const check = () => {
      if (entry.exit !== null) {
        clearTimeout(timer);
        resolve(true);
        return;
      }
      cancel = entry.onceChanged(entry.version, check);
    };
    check();
  });

const ensureHome = async (deps: LifecycleDeps, home: string) => {
  await NodeFSP.mkdir(home, { recursive: true });
  // On the EFS access point every file already belongs to the access point's
  // user; a local home has to be handed to the child user explicitly.
  if (deps.config.childUid !== undefined && deps.config.childGid !== undefined) {
    await NodeFSP.chown(home, deps.config.childUid, deps.config.childGid).catch(() => {});
  }
};

export const applyRunPayload = async (
  deps: LifecycleDeps,
  microvmId: string | null,
  payload: ThreadRunnerRunPayload,
): Promise<void> => {
  const { state, log } = deps;
  state.microvmId = microvmId;
  state.payload = payload;
  log("run payload applied", {
    microvmId,
    threadId: payload.threadId ?? null,
    tenantId: payload.tenantId ?? null,
  });

  if (payload.workspace) {
    const started = Date.now();
    try {
      await mountWorkspace(payload.workspace, {
        efsUtilsConfigPath: deps.config.efsUtilsConfigPath,
      });
      state.workspace = { state: "mounted", detail: payload.workspace.mountPath };
      log("workspace mounted", {
        mountPath: payload.workspace.mountPath,
        durationMs: Date.now() - started,
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      state.workspace = { state: "failed", detail };
      log("workspace mount failed", { detail, durationMs: Date.now() - started });
    }
  }

  const home = state.baseEnv().HOME;
  if (home) {
    await ensureHome(deps, home).catch((cause) =>
      log("could not create HOME", { home, cause: String(cause) }),
    );
  }

  if (payload.docker !== false) deps.docker.start();
};

export const resume = async (deps: LifecycleDeps): Promise<void> => {
  const workspace = deps.state.payload?.workspace;
  if (workspace && deps.state.workspace.state === "mounted") {
    if (!(await checkWorkspace(workspace.mountPath))) {
      deps.log("workspace unresponsive after resume; remounting", {
        mountPath: workspace.mountPath,
      });
      if (await isMounted(workspace.mountPath)) {
        await runCommand("umount", ["-l", workspace.mountPath], { timeoutMs: 10_000 });
      }
      try {
        await mountWorkspace(workspace, { efsUtilsConfigPath: deps.config.efsUtilsConfigPath });
      } catch (cause) {
        deps.state.workspace = {
          state: "failed",
          detail: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }
  }
  await deps.docker.ensureRunning();
};

/** Flushes writes to EFS before the VM freezes, so the server reads current files meanwhile. */
export const suspend = async (_deps: LifecycleDeps): Promise<void> => {
  await runCommand("sync", [], { timeoutMs: 20_000 });
};

export const terminate = async (deps: LifecycleDeps): Promise<void> => {
  deps.table.signalAll("SIGTERM");
  await sleep(1_500);
  deps.docker.stop();
  await runCommand("sync", [], { timeoutMs: 20_000 });
};

/**
 * Runs once on a fresh VM after the image build. Exercising the spawn and PTY
 * paths here also lets Lambda prefetch the snapshot pages they touch.
 */
export const validate = async (deps: LifecycleDeps): Promise<boolean> => {
  const env = deps.state.baseEnv();
  const checks = [
    { processId: "validate-pipes", pty: undefined },
    { processId: "validate-pty", pty: { cols: 80, rows: 24 } },
  ] as const;
  for (const check of checks) {
    const spawned = await deps.table
      .spawn({
        processId: check.processId,
        command: "/bin/sh",
        args: ["-c", "echo t3-runner-validate"],
        env,
        pty: check.pty,
      })
      .catch((cause: unknown) => {
        deps.log("validate spawn failed", { processId: check.processId, cause: String(cause) });
        return null;
      });
    if (spawned === null) return false;
    const exited = await waitForExit(spawned, 10_000);
    deps.table.release(check.processId);
    if (!exited || spawned.exit?.exitCode !== 0) return false;
  }
  return true;
};
