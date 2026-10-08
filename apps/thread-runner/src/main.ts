// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off globalDate:off - process entry point; logs are JSON lines on stdout for CloudWatch.
/**
 * Thread runner entry point. Serves Lambda's lifecycle hooks on one port and
 * the runner RPC WebSocket on another; only the RPC port is reachable through
 * the VM's endpoint token.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import {
  THREAD_RUNNER_RPC_PATH,
  THREAD_RUNNER_SECRET_HEADER,
  ThreadRunnerRpcGroup,
  ThreadRunnerRunPayload,
} from "@t3tools/contracts/threadRunner";

import packageJson from "../package.json" with { type: "json" };
import { readRunnerConfig } from "./config.ts";
import { DockerDaemon } from "./docker.ts";
import * as Lifecycle from "./lifecycle.ts";
import { ProcessTable } from "./ProcessTable.ts";
import { makeRunnerRpcHandlers } from "./RunnerRpc.ts";
import { RunnerState } from "./RunnerState.ts";

const HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1";

const log = (message: string, fields: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), message, ...fields }));
};

// node-pty dlopens a native addon, so it stays outside the bundle and is
// required from the image's node_modules.
const requireForNodePty = NodeModule.createRequire(import.meta.url);

const config = readRunnerConfig(process.env);
const state = new RunnerState(config);
const table = new ProcessTable({
  outputBufferBytes: config.outputBufferBytes,
  childUid: config.childUid,
  childGid: config.childGid,
  exitedRetentionMs: config.exitedRetentionMs,
  loadPty: () => requireForNodePty("node-pty") as typeof import("node-pty"),
  log,
});
const docker = new DockerDaemon(state, {
  startScript: config.dockerStartScript,
  socketGroup: config.childUser,
  log,
});
const lifecycleDeps: Lifecycle.LifecycleDeps = { config, state, table, docker, log };

const RunHookBody = Schema.Struct({
  microvmId: Schema.optional(Schema.String),
  runHookPayload: Schema.optional(Schema.String),
});
const decodeRunHookBody = Schema.decodeUnknownEffect(RunHookBody);
const decodeRunPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadRunnerRunPayload));

const ok = HttpServerResponse.text("ok");

const hook = (name: string, run: () => Promise<void>) =>
  HttpRouter.add(
    "POST",
    `${HOOK_PREFIX}/${name}`,
    Effect.promise(run).pipe(
      Effect.as(ok),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          log(`${name} hook failed`, { cause: String(cause) });
          return HttpServerResponse.text(`${name} failed`, { status: 500 });
        }),
      ),
    ),
  );

const HookRoutes = Layer.mergeAll(
  HttpRouter.add("POST", `${HOOK_PREFIX}/ready`, ok),
  HttpRouter.add(
    "POST",
    `${HOOK_PREFIX}/validate`,
    Effect.promise(() => Lifecycle.validate(lifecycleDeps)).pipe(
      Effect.map((passed) =>
        passed ? ok : HttpServerResponse.text("validation failed", { status: 500 }),
      ),
    ),
  ),
  HttpRouter.add(
    "POST",
    `${HOOK_PREFIX}/run`,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* request.json.pipe(Effect.flatMap(decodeRunHookBody));
      const payload = yield* decodeRunPayload(body.runHookPayload ?? "");
      yield* Effect.promise(() =>
        Lifecycle.applyRunPayload(lifecycleDeps, body.microvmId ?? null, payload),
      );
      return ok;
    }).pipe(
      // Lambda terminates a VM whose `/run` fails; without a valid payload the
      // VM can never accept work, so failing fast is the useful outcome.
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          log("run hook rejected", { cause: String(cause) });
          return HttpServerResponse.text("invalid run payload", { status: 400 });
        }),
      ),
    ),
  ),
  hook("resume", () => Lifecycle.resume(lifecycleDeps)),
  hook("suspend", () => Lifecycle.suspend(lifecycleDeps)),
  hook("terminate", () => Lifecycle.terminate(lifecycleDeps)),
);

const secretMatches = (provided: string, expected: string) => {
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return (
    providedBytes.byteLength === expectedBytes.byteLength &&
    NodeCrypto.timingSafeEqual(providedBytes, expectedBytes)
  );
};

const RpcRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    yield* RpcServer.make(ThreadRunnerRpcGroup).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.forkScoped,
    );
    yield* router.add(
      "GET",
      THREAD_RUNNER_RPC_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const expected = state.secret;
        if (expected === null) {
          return HttpServerResponse.text("runner not configured", { status: 503 });
        }
        const provided = request.headers[THREAD_RUNNER_SECRET_HEADER];
        if (typeof provided !== "string" || !secretMatches(provided, expected)) {
          return HttpServerResponse.text("unauthorized", { status: 401 });
        }
        return yield* httpEffect;
      }),
    );
    yield* router.add(
      "GET",
      "/healthz",
      Effect.sync(() =>
        HttpServerResponse.jsonUnsafe({ ok: true, configured: state.secret !== null }),
      ),
    );
  }),
).pipe(
  Layer.provide(
    ThreadRunnerRpcGroup.toLayer(
      makeRunnerRpcHandlers({ table, state, runnerVersion: packageJson.version }),
    ),
  ),
  Layer.provide(RpcSerialization.layerJson),
);

const HookServer = HttpRouter.serve(HookRoutes, { disableLogger: true }).pipe(
  Layer.provide(
    NodeHttpServer.layer(() => NodeHttp.createServer(), {
      host: config.host,
      port: config.hookPort,
    }),
  ),
);

const RunnerRpcServer = HttpRouter.serve(RpcRoutes, { disableLogger: true }).pipe(
  Layer.provide(
    NodeHttpServer.layer(() => NodeHttp.createServer(), {
      host: config.host,
      port: config.rpcPort,
      websocket: { perMessageDeflate: true },
    }),
  ),
);

const sweepTimer = setInterval(() => table.sweep(Date.now()), 60_000);
sweepTimer.unref();

process.once("SIGTERM", () => {
  table.signalAll("SIGTERM");
  docker.stop();
});

const Startup = Layer.effectDiscard(
  Effect.promise(async () => {
    log("thread runner starting", {
      version: packageJson.version,
      rpcPort: config.rpcPort,
      hookPort: config.hookPort,
    });
    if (config.devPayload) {
      await Lifecycle.applyRunPayload(lifecycleDeps, null, config.devPayload);
    }
  }),
);

Layer.launch(Layer.mergeAll(HookServer, RunnerRpcServer, Startup)).pipe(NodeRuntime.runMain);
