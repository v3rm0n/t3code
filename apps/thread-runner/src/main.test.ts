// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off - drives the real runner process over HTTP.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { THREAD_RUNNER_METHODS } from "@t3tools/contracts/threadRunner";

import { makeRunnerClient } from "../scripts/runnerClient.ts";

const SECRET = "test-secret-0123456789abcdefghijklmnopqrstuvwxyz";

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
let rpcPort = 0;
let hookPort = 0;

beforeAll(async () => {
  rpcPort = await freePort();
  hookPort = await freePort();
  runner = NodeChildProcess.spawn(
    process.execPath,
    [NodePath.join(import.meta.dirname, "main.ts")],
    {
      env: {
        ...process.env,
        T3_RUNNER_HOST: "127.0.0.1",
        T3_RUNNER_RPC_PORT: String(rpcPort),
        T3_RUNNER_HOOK_PORT: String(hookPort),
        T3_RUNNER_DEV_PAYLOAD: JSON.stringify({ version: 1, runnerSecret: SECRET, docker: false }),
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  await new Promise<void>((resolve, reject) => {
    runner?.once("exit", (code) => reject(new Error(`runner exited early with ${code}`)));
    runner?.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("run payload applied")) resolve();
    });
  });
});

afterAll(() => {
  runner?.kill("SIGTERM");
});

describe("thread runner over a real socket", () => {
  it.effect("streams non-ASCII output intact through the JSON transport", () =>
    Effect.gen(function* () {
      const client = yield* makeRunnerClient({
        baseUrl: `ws://127.0.0.1:${rpcPort}`,
        runnerSecret: SECRET,
      });
      yield* client[THREAD_RUNNER_METHODS.spawn]({
        processId: "utf8",
        command: "/bin/sh",
        args: ["-c", "printf '\\342\\234\\223 done'"],
        env: {},
      });
      const events = yield* Stream.runCollect(
        client[THREAD_RUNNER_METHODS.attach]({ processId: "utf8", fromOffset: 0 }),
      );
      const bytes = events.flatMap((event) => (event._tag === "Output" ? [...event.data] : []));
      assert.strictEqual(new TextDecoder().decode(Uint8Array.from(bytes)), "✓ done");
      assert.deepStrictEqual(events.at(-1), { _tag: "Exit", exitCode: 0, signal: null });
    }).pipe(Effect.scoped),
  );

  it.effect("refuses connections without the run payload's secret", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.gen(function* () {
        const client = yield* makeRunnerClient({
          baseUrl: `ws://127.0.0.1:${rpcPort}`,
          runnerSecret: "wrong-secret-0123456789abcdefghijklmnopqrstuvwxyz",
        });
        return yield* client[THREAD_RUNNER_METHODS.status]();
      }).pipe(Effect.scoped, Effect.flip);
      // The upgrade is answered 401, so the socket never opens.
      assert.strictEqual(failure._tag, "RpcClientError");
    }),
  );

  it.effect("rejects a run hook without a valid payload", () =>
    Effect.promise(async () => {
      const ready = await fetch(
        `http://127.0.0.1:${hookPort}/aws/lambda-microvms/runtime/v1/ready`,
        {
          method: "POST",
        },
      );
      assert.strictEqual(ready.status, 200);
      const run = await fetch(`http://127.0.0.1:${hookPort}/aws/lambda-microvms/runtime/v1/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ microvmId: "mvm-test", runHookPayload: "{}" }),
      });
      assert.strictEqual(run.status, 400);
    }),
  );
});
