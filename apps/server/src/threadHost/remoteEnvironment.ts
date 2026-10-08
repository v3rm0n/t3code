/**
 * The environment a thread process gets in its VM: what T3 and the provider
 * intended for it, minus everything that describes this server. The runner
 * supplies the VM's own PATH, HOME, locale, and caches, and the VM gets AWS
 * credentials from its own execution role.
 */
const HOST_KEYS = new Set([
  "PATH",
  "HOME",
  "PWD",
  "OLDPWD",
  "HOSTNAME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHLVL",
  "_",
  "LANG",
  "LC_ALL",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "COLORTERM",
  "NODE_OPTIONS",
  "NODE_PATH",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_EXECUTION_ENV",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "ECS_CONTAINER_METADATA_URI",
  "ECS_CONTAINER_METADATA_URI_V4",
  "ECS_AGENT_URI",
  "T3CODE_HOME",
  "T3CODE_PORT",
  "T3CODE_HOST",
  "T3CODE_MODE",
  "T3CODE_NO_BROWSER",
  "T3CODE_SHARED_DIR",
  "T3CODE_MCP_ADVERTISED_URL",
  "T3CODE_LOG_LEVEL",
  "T3CODE_DEV_AUTH_TOKEN",
]);

const HOST_PREFIXES = [
  "npm_",
  "PNPM_",
  "VSCODE_",
  "T3CODE_MICROVM_",
  "T3CODE_THREAD_",
  "T3_SPIKE_",
];

/** Provider homes are kept only when they point into the shared directory. */
const SHARED_PATH_KEYS = new Set(["CLAUDE_CONFIG_DIR", "CODEX_HOME"]);

export const isUnderDirectory = (path: string, directory: string) => {
  const root = directory.endsWith("/") ? directory.slice(0, -1) : directory;
  return path === root || path.startsWith(`${root}/`);
};

export const remoteEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
  sharedDir: string,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (HOST_KEYS.has(key) || HOST_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (SHARED_PATH_KEYS.has(key) && !isUnderDirectory(value, sharedDir)) continue;
    result[key] = value;
  }
  return result;
};
