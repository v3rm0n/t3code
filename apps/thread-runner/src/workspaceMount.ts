// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - mounts NFS and probes it with a bounded stat.
/**
 * Mounts the tenant's shared workspace (an EFS access point) at the same path
 * the T3 server sees it, so paths in prompts, checkpoints, and attachments mean
 * the same file on both sides. Uses amazon-efs-utils with TLS and IAM, which
 * picks up the VM's execution-role credentials from instance metadata.
 */
import * as NodeFSP from "node:fs/promises";

import type { ThreadRunnerRunPayload } from "@t3tools/contracts/threadRunner";

import { describeFailure, runCommand } from "./command.ts";

type WorkspaceSpec = NonNullable<ThreadRunnerRunPayload["workspace"]>;

/** Lambda gives `/run` at most 60 seconds, which has to cover the mount. */
const MOUNT_TIMEOUT_MS = 40_000;
const HEALTH_TIMEOUT_MS = 5_000;

export const isMounted = async (mountPath: string): Promise<boolean> => {
  const mounts = await NodeFSP.readFile("/proc/mounts", "utf8").catch(() => "");
  return mounts.split("\n").some((line) => line.split(" ")[1] === mountPath);
};

/** efs-utils reads the region from its config when instance metadata has no identity document. */
export const configureEfsUtilsRegion = async (configPath: string, region: string) => {
  const current = await NodeFSP.readFile(configPath, "utf8").catch(() => null);
  if (current === null) return;
  const regionLine = `region = ${region}`;
  const next = /^#?\s*region\s*=.*$/m.test(current)
    ? current.replace(/^#?\s*region\s*=.*$/m, regionLine)
    : current.replace(/^\[mount\]\s*$/m, `[mount]\n${regionLine}`);
  if (next !== current) await NodeFSP.writeFile(configPath, next);
};

export const mountWorkspace = async (
  workspace: WorkspaceSpec,
  options: { readonly efsUtilsConfigPath: string },
): Promise<void> => {
  await NodeFSP.mkdir(workspace.mountPath, { recursive: true });
  if (await isMounted(workspace.mountPath)) return;
  if (workspace.region) {
    await configureEfsUtilsRegion(options.efsUtilsConfigPath, workspace.region);
  }
  const mountOptions = [
    "tls",
    "iam",
    `accesspoint=${workspace.accessPointId}`,
    ...(workspace.mountTargetIp ? [`mounttargetip=${workspace.mountTargetIp}`] : []),
  ].join(",");
  const result = await runCommand(
    "mount",
    ["-t", "efs", "-o", mountOptions, `${workspace.fileSystemId}:/`, workspace.mountPath],
    { timeoutMs: MOUNT_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      describeFailure(`mount ${workspace.fileSystemId} at ${workspace.mountPath}`, result),
    );
  }
};

/** A suspended VM can come back with a stale NFS session; a bounded stat tells us. */
export const checkWorkspace = async (mountPath: string): Promise<boolean> => {
  const stat = NodeFSP.statfs(mountPath).then(
    () => true,
    () => false,
  );
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), HEALTH_TIMEOUT_MS).unref();
  });
  return Promise.race([stat, timeout]);
};
