// @effect-diagnostics nodeBuiltinImport:off - short system commands (mount, sync, docker) outside Effect.
import * as NodeChildProcess from "node:child_process";

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a short system command (mount, sync, docker info) as the runner's own user. */
export const runCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly timeoutMs: number; readonly env?: NodeJS.ProcessEnv },
): Promise<CommandResult> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      {
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        ...(options.env === undefined ? {} : { env: options.env }),
      },
      (error, stdout, stderr) => {
        const exitCode =
          error === null
            ? 0
            : typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
              ? ((error as unknown as { code: number }).code ?? null)
              : null;
        resolve({
          exitCode,
          stdout: String(stdout),
          stderr: error !== null && String(stderr) === "" ? error.message : String(stderr),
        });
      },
    );
  });

export const describeFailure = (label: string, result: CommandResult): string =>
  `${label} failed (exit ${result.exitCode ?? "none"}): ${(result.stderr || result.stdout).trim().slice(-2_000)}`;
