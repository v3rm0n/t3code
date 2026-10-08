/**
 * Decides where a thread's processes run. In `local` mode nothing changes. In
 * the remote modes each thread gets a runner (a MicroVM per thread, or one
 * shared runner in development) that runs its provider processes, terminals,
 * and setup scripts against the shared directory both sides mount at the same
 * path. Git, checkpoints, and file access stay on this server.
 */
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import type { ThreadRunnerRunPayload } from "@t3tools/contracts/threadRunner";

import { makeMicrovmApi } from "./MicrovmApi.ts";
import { makeRemoteRuntime, RemoteProcess } from "./RemoteProcess.ts";
import { isUnderDirectory, remoteEnvironment } from "./remoteEnvironment.ts";
import { type ThreadHostConfig, ThreadHostConfigFromEnv } from "./ThreadHostConfig.ts";
import { ThreadHostError } from "./ThreadHostError.ts";
import { makeVmConnection, type VmConnection, type VmEndpoint } from "./VmConnection.ts";

/** Terminal traffic keeps a VM awake for this long. */
const TERMINAL_IDLE = Duration.minutes(10);
const IDLE_SWEEP_INTERVAL = Duration.seconds(30);

export interface RemoteSpawnRequest {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  /** Already filtered for the VM; see `remoteEnvironment`. */
  readonly env: Readonly<Record<string, string>>;
  readonly pty?: { readonly cols: number; readonly rows: number } | undefined;
}

export interface ThreadHostShape {
  /** False in local mode, where callers keep spawning processes on this machine. */
  readonly remote: boolean;
  /** The directory both this server and thread VMs see; undefined in local mode. */
  readonly sharedDir: string | undefined;
  /** Prepares a process; `start` (or `begin`) launches it in the thread's VM. */
  readonly prepare: (
    threadId: string,
    request: RemoteSpawnRequest,
  ) => Effect.Effect<RemoteProcess, ThreadHostError>;
  /** `prepare` for callers that must return synchronously; throws what `prepare` fails with. */
  readonly prepareSync: (threadId: string, request: RemoteSpawnRequest) => RemoteProcess;
  /** This server's environment, minus what describes this machine. */
  readonly environmentFor: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Record<string, string>;
}

const noRemoteHost = new ThreadHostError({
  reason: "spawn-failed",
  detail: "Threads run on this machine; there is no remote host.",
});

const localThreadHost: ThreadHostShape = {
  remote: false,
  sharedDir: undefined,
  prepare: () => Effect.fail(noRemoteHost),
  prepareSync: () => {
    throw noRemoteHost;
  },
  environmentFor: (env) =>
    Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
};

/** Defaults to local mode, so only a server configured for remote threads provides it. */
export const ThreadHost = Context.Reference<ThreadHostShape>("t3/threadHost/ThreadHost", {
  defaultValue: () => localThreadHost,
});

const makeRemote = Effect.fn("ThreadHost.makeRemote")(function* (
  config: Exclude<ThreadHostConfig, { readonly kind: "local" }>,
) {
  const crypto = yield* Crypto.Crypto;
  const context = yield* Effect.context<never>();
  const runtime = yield* makeRemoteRuntime;
  const microvms = config.kind === "microvm" ? makeMicrovmApi(config.microvm) : null;
  const connections = new Map<string, Deferred.Deferred<VmConnection, ThreadHostError>>();
  /** Connections that finished connecting, for the idle sweep. */
  const established = new Set<VmConnection>();

  const randomToken = crypto.randomBytes(32).pipe(Effect.map(Base64Url.encode), Effect.orDie);

  const endpointFor = Effect.fn("ThreadHost.endpointFor")(function* (threadId: string) {
    if (config.kind === "runner") {
      return {
        label: `runner ${config.runnerUrl}`,
        target: Effect.succeed({ baseUrl: config.runnerUrl, runnerSecret: config.runnerSecret }),
        isGone: Effect.succeed(false),
        terminate: Effect.void,
      } satisfies VmEndpoint;
    }
    if (microvms === null || config.kind !== "microvm") {
      return yield* new ThreadHostError({
        reason: "launch-failed",
        detail: "No MicroVM settings.",
      });
    }
    const runnerSecret = yield* randomToken;
    const payload: ThreadRunnerRunPayload = {
      version: 1,
      runnerSecret,
      threadId,
      workspace: {
        fileSystemId: config.microvm.fileSystemId,
        accessPointId: config.microvm.accessPointId,
        mountPath: config.sharedDir,
        region: config.microvm.region,
      },
      home: `${config.sharedDir}/home`,
      docker: true,
    };
    const vm = yield* microvms.launch({ payload, idempotencyKey: yield* randomToken });
    yield* Effect.logInfo("thread VM launched", { threadId, microvmId: vm.microvmId });
    return {
      label: `MicroVM ${vm.microvmId}`,
      target: microvms.authHeaders(vm.microvmId).pipe(
        Effect.map((authHeaders) => ({
          baseUrl: `wss://${vm.endpoint}`,
          runnerSecret,
          authHeaders,
        })),
      ),
      isGone: microvms.isGone(vm.microvmId),
      terminate: microvms.terminate(vm.microvmId),
    } satisfies VmEndpoint;
  });

  /** One connection per thread (or one overall for a shared runner), created on first use. */
  const connectionFor = (threadId: string): Effect.Effect<VmConnection, ThreadHostError> =>
    Effect.gen(function* () {
      const key = config.kind === "runner" ? "runner" : threadId;
      const existing = connections.get(key);
      if (existing !== undefined) {
        const connection = yield* Deferred.await(existing).pipe(Effect.result);
        if (connection._tag === "Success" && !connection.success.gone()) {
          return connection.success;
        }
        if (connection._tag === "Success") established.delete(connection.success);
        if (connections.get(key) === existing) connections.delete(key);
      }
      const created = Deferred.makeUnsafe<VmConnection, ThreadHostError>();
      connections.set(key, created);
      runtime.runFork(
        endpointFor(threadId).pipe(
          Effect.flatMap((endpoint) => makeVmConnection(endpoint, { terminalIdle: TERMINAL_IDLE })),
          Effect.tap((connection) => Effect.sync(() => established.add(connection))),
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(created, exit)),
          Effect.asVoid,
        ),
      );
      return yield* Deferred.await(created).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            if (connections.get(key) === created) connections.delete(key);
          }),
        ),
      );
    });

  // Close sockets to VMs with nothing to do, so Lambda can suspend them.
  yield* Effect.suspend(() =>
    Effect.forEach(established, (connection) => connection.closeIfIdle, { discard: true }),
  ).pipe(Effect.repeat(Schedule.spaced(IDLE_SWEEP_INTERVAL)), Effect.forkScoped);

  const prepare = (threadId: string, request: RemoteSpawnRequest) =>
    Effect.gen(function* () {
      if (request.cwd !== undefined && !isUnderDirectory(request.cwd, config.sharedDir)) {
        return yield* new ThreadHostError({
          reason: "outside-shared-dir",
          detail: `${request.cwd} is not under ${config.sharedDir}, which thread VMs mount. Move the project under ${config.sharedDir} to run its threads remotely.`,
        });
      }
      const processId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      return new RemoteProcess({
        spec: {
          processId,
          command: request.command,
          args: [...request.args],
          env: { ...request.env },
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          ...(request.pty === undefined ? {} : { pty: request.pty }),
        },
        connection: connectionFor(threadId),
        runtime,
      });
    });

  return {
    remote: true,
    sharedDir: config.sharedDir,
    prepare,
    prepareSync: (threadId, request) =>
      Effect.runSyncWith(context)(
        prepare(threadId, request).pipe(Effect.catch((error) => Effect.die(error))),
      ),
    environmentFor: (env) => remoteEnvironment(env, config.sharedDir),
  } satisfies ThreadHostShape;
});

export const layer = Layer.effect(
  ThreadHost,
  Effect.gen(function* () {
    const config = yield* ThreadHostConfigFromEnv;
    if (config.kind === "local") return localThreadHost;
    yield* Effect.logInfo("threads run remotely", {
      kind: config.kind,
      sharedDir: config.sharedDir,
    });
    return yield* makeRemote(config);
  }),
);
