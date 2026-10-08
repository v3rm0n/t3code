/**
 * `spawnClaudeCodeProcess` for the Claude Agent SDK when threads run remotely.
 * The SDK keeps running here (its control protocol, permission callbacks, and
 * MCP configuration are unchanged); only the `claude` CLI moves to the thread's
 * VM, which has its own `claude` on PATH.
 */
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import { sdkProcessView } from "./RemoteProcessViews.ts";
import type { ThreadHostShape } from "./ThreadHost.ts";

const SCRIPT_RUNNERS = new Set(["node", "bun", "deno"]);

/**
 * The SDK launches either the CLI binary or `node cli.js`. In the VM the CLI is
 * the image's `claude`, so the server-side path (and any script argument) is dropped.
 */
export const remoteClaudeLaunch = (
  options: Pick<SpawnOptions, "command" | "args">,
  remoteCommand: string,
): { readonly command: string; readonly args: ReadonlyArray<string> } => {
  const executable = options.command.split(/[\\/]/).pop() ?? options.command;
  const runsScript = SCRIPT_RUNNERS.has(executable) && /\.[cm]?js$/.test(options.args[0] ?? "");
  return { command: remoteCommand, args: runsScript ? options.args.slice(1) : options.args };
};

export const remoteClaudeSpawner =
  (host: ThreadHostShape, threadId: string, remoteCommand = "claude") =>
  (options: SpawnOptions): SpawnedProcess => {
    const launch = remoteClaudeLaunch(options, remoteCommand);
    const remote = host.prepareSync(threadId, {
      command: launch.command,
      args: launch.args,
      cwd: options.cwd,
      env: host.environmentFor(options.env),
    });
    const child = sdkProcessView(remote);
    // The SDK aborts only after closing stdin and a grace period, so this is the hard stop.
    options.signal.addEventListener(
      "abort",
      () => {
        remote.signal("SIGKILL").catch(() => {});
      },
      { once: true },
    );
    remote.begin((error) => child.fail(error));
    return child;
  };
