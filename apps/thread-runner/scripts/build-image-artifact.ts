// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - build script, plain Node.
/**
 * Stages the MicroVM image artifact: the Dockerfile at the zip root, the start
 * script, and the bundled runner with a package.json that installs node-pty.
 * Prints the zip path for `infra/aws-microvm-spike/scripts/build-thread-image.sh`.
 *
 *   node apps/thread-runner/scripts/build-image-artifact.ts [--skip-bundle]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const appDir = NodePath.dirname(import.meta.dirname);
const stagingRoot = NodePath.join(appDir, ".artifact");
const stagingDir = NodePath.join(stagingRoot, "image");
const zipPath = NodePath.join(stagingRoot, "thread-runner-image.zip");

const run = (command: string, args: ReadonlyArray<string>, cwd: string) => {
  const result = NodeChildProcess.spawnSync(command, [...args], { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
};

if (!process.argv.includes("--skip-bundle")) {
  run("npx", ["vp", "pack"], appDir);
}

const bundle = NodePath.join(appDir, "dist", "main.mjs");
if (!NodeFS.existsSync(bundle)) throw new Error(`Missing ${bundle}; run vp pack first.`);

// The image installs the exact node-pty the tests ran against.
const requireFromApp = NodeModule.createRequire(NodePath.join(appDir, "package.json"));
const nodePtyVersion = (requireFromApp("node-pty/package.json") as { version: string }).version;

NodeFS.rmSync(stagingRoot, { recursive: true, force: true });
NodeFS.mkdirSync(NodePath.join(stagingDir, "runner"), { recursive: true });
NodeFS.copyFileSync(
  NodePath.join(appDir, "image", "Dockerfile"),
  NodePath.join(stagingDir, "Dockerfile"),
);
NodeFS.copyFileSync(
  NodePath.join(appDir, "image", "start-dockerd.sh"),
  NodePath.join(stagingDir, "start-dockerd.sh"),
);
for (const file of ["main.mjs", "main.mjs.map"]) {
  NodeFS.copyFileSync(
    NodePath.join(appDir, "dist", file),
    NodePath.join(stagingDir, "runner", file),
  );
}
NodeFS.writeFileSync(
  NodePath.join(stagingDir, "runner", "package.json"),
  `${JSON.stringify(
    {
      name: "t3-thread-runner-image",
      private: true,
      type: "module",
      dependencies: { "node-pty": nodePtyVersion },
    },
    null,
    2,
  )}\n`,
);

run("zip", ["-q", "-r", "-X", zipPath, "."], stagingDir);
const sha256 = NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(zipPath)).digest("hex");
console.log(`artifact: ${zipPath}`);
console.log(`sha256: ${sha256}`);
