// @effect-diagnostics nodeBuiltinImport:off - starts a real thread runner process for the tests.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { makeRemoteRuntime, RemoteProcess } from "./RemoteProcess.ts";
import { makeCodexStdio, ptyProcessView, sdkProcessView } from "./RemoteProcessViews.ts";
import * as ThreadHost from "./ThreadHost.ts";
import { makeVmConnection } from "./VmConnection.ts";

const SECRET = "thread-host-test-secret-0123456789abcdefghij";
const RUNNER_MAIN = NodePath.resolve(import.meta.dirname, "../../../thread-runner/src/main.ts");
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

let runner: NodeChildProcess.ChildProcess | undefined;
let runnerUrl = "";
let sharedDir = "";

beforeAll(async () => {
  sharedDir = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-thread-host-")),
  );
  const rpcPort = await freePort();
  const hookPort = await freePort();
  runnerUrl = `ws://127.0.0.1:${rpcPort}`;
  runner = NodeChildProcess.spawn(process.execPath, [RUNNER_MAIN], {
    env: {
      ...process.env,
      T3_RUNNER_HOST: "127.0.0.1",
      T3_RUNNER_RPC_PORT: String(rpcPort),
      T3_RUNNER_HOOK_PORT: String(hookPort),
      T3_RUNNER_DEV_PAYLOAD: JSON.stringify({ version: 1, runnerSecret: SECRET, docker: false }),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    runner?.once("exit", (code) => reject(new Error(`runner exited early with ${code}`)));
    runner?.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("run payload applied")) resolve();
    });
  });
});

afterAll(() => {
  runner?.kill("SIGTERM");
  NodeFS.rmSync(sharedDir, { recursive: true, force: true });
});

const hostLayer = () =>
  ThreadHost.layer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_THREAD_HOST: "runner",
            T3CODE_SHARED_DIR: sharedDir,
            T3CODE_THREAD_RUNNER_URL: runnerUrl,
            T3CODE_THREAD_RUNNER_SECRET: SECRET,
          },
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

describe("ThreadHost with a runner", () => {
  it.live("runs a provider process remotely behind the Agent SDK's process interface", () =>
    Effect.gen(function* () {
      const host = yield* ThreadHost.ThreadHost;
      assert.isTrue(host.remote);
      const remote = yield* host.prepare("thread-a", {
        command: "/bin/sh",
        args: ["-c", 'printf "hello "; read line; printf "got:%s" "$line"'],
        cwd: sharedDir,
        env: {},
      });
      const child = sdkProcessView(remote);
      const chunks: Array<string> = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
      const ended = new Promise<void>((resolve) => child.stdout.once("end", resolve));
      const exited = new Promise<number | null>((resolve) =>
        child.once("exit", (code) => resolve(code)),
      );
      remote.begin(() => {});
      child.stdin.write("ping\n");
      const code = yield* Effect.promise(() => exited);
      yield* Effect.promise(() => ended);
      assert.strictEqual(code, 0);
      assert.strictEqual(chunks.join(""), "hello got:ping");
    }).pipe(Effect.provide(hostLayer())),
  );

  it.live("runs terminals in a remote PTY with a pid that is never local", () =>
    Effect.gen(function* () {
      const host = yield* ThreadHost.ThreadHost;
      const remote = yield* host.prepare("thread-a", {
        command: "/bin/sh",
        args: ["-c", "printf pty-ok"],
        cwd: sharedDir,
        env: {},
        pty: { cols: 80, rows: 24 },
      });
      const pty = ptyProcessView(remote);
      let output = "";
      pty.onData((data) => {
        output += data;
      });
      const exited = new Promise<number>((resolve) =>
        pty.onExit((event) => resolve(event.exitCode)),
      );
      yield* remote.start();
      assert.strictEqual(yield* Effect.promise(() => exited), 0);
      assert.include(output, "pty-ok");
      assert.isBelow(pty.pid, 0);
    }).pipe(Effect.provide(hostLayer())),
  );

  it.live("bridges Codex's byte streams to a remote process", () =>
    Effect.gen(function* () {
      const host = yield* ThreadHost.ThreadHost;
      const remote = yield* host.prepare("thread-a", {
        command: "cat",
        args: [],
        cwd: sharedDir,
        env: {},
      });
      const stdio = yield* makeCodexStdio(remote);
      yield* remote.start();
      yield* Stream.make(encoder.encode('{"id":1}\n')).pipe(Stream.run(stdio.stdout()));
      const echoed = yield* stdio.stdin.pipe(Stream.take(1), Stream.runCollect);
      assert.strictEqual(decoder.decode(echoed[0]), '{"id":1}\n');
      yield* Effect.promise(() => remote.signal("SIGTERM"));
      yield* Effect.promise(() => remote.waitForExit());
    }).pipe(Effect.provide(hostLayer())),
  );

  it.live("refuses working directories the VM cannot see", () =>
    Effect.gen(function* () {
      const host = yield* ThreadHost.ThreadHost;
      const error = yield* host
        .prepare("thread-a", {
          command: "/bin/true",
          args: [],
          cwd: "/definitely/elsewhere",
          env: {},
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "outside-shared-dir");
    }).pipe(Effect.provide(hostLayer())),
  );
});

describe("RemoteProcess", () => {
  it.live("resumes output from its last offset after the connection drops", () =>
    Effect.gen(function* () {
      const connection = yield* makeVmConnection(
        {
          label: "test runner",
          target: Effect.succeed({ baseUrl: runnerUrl, runnerSecret: SECRET }),
          isGone: Effect.succeed(false),
          terminate: Effect.void,
        },
        { terminalIdle: Duration.minutes(10) },
      );
      const runtime = yield* makeRemoteRuntime;
      const remote = new RemoteProcess({
        spec: {
          processId: "ticks",
          command: "/bin/sh",
          args: ["-c", "for i in 1 2 3 4; do echo tick-$i; sleep 0.3; done"],
          env: {},
        },
        connection: Effect.succeed(connection),
        runtime,
      });
      const firstTick = yield* Deferred.make<void>();
      let output = "";
      remote.onData((data) => {
        output += decoder.decode(data);
        if (output.includes("tick-1")) Deferred.doneUnsafe(firstTick, Effect.void);
      });
      yield* remote.start();
      yield* Deferred.await(firstTick);
      // Drop the socket under the running process, as a suspend or network blip would.
      yield* connection.invalidate(yield* connection.client);
      const exit = yield* Effect.promise(() => remote.waitForExit());
      assert.deepStrictEqual(exit, { exitCode: 0, signal: null });
      assert.strictEqual(output.match(/tick-\d/g)?.join(","), "tick-1,tick-2,tick-3,tick-4");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
