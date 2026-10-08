// @effect-diagnostics globalDate:off - terminal activity is noted from synchronous PTY callbacks.
/**
 * The server's connection to one thread VM's runner. Connecting through the
 * MicroVM endpoint resumes a suspended VM, so this connects lazily, reconnects
 * after drops, and closes the socket once the VM has nothing to do: no live
 * provider process and no recent terminal traffic. With the socket closed the
 * endpoint goes quiet and Lambda's idle policy suspends the VM.
 */
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { THREAD_RUNNER_METHODS } from "@t3tools/contracts/threadRunner";

import { makeRunnerClient, type RunnerClient, type RunnerTarget } from "./runnerSocket.ts";
import { ThreadHostError } from "./ThreadHostError.ts";

/** Covers resuming a suspended VM, which holds the first request. */
const FIRST_REQUEST_TIMEOUT = Duration.seconds(90);

export interface VmEndpoint {
  readonly label: string;
  /** URL and fresh credentials for one connection attempt. */
  readonly target: Effect.Effect<RunnerTarget, ThreadHostError>;
  readonly isGone: Effect.Effect<boolean>;
  readonly terminate: Effect.Effect<void>;
}

export interface VmConnection {
  readonly label: string;
  /** A connected client, reconnecting (and resuming the VM) when needed. */
  readonly client: Effect.Effect<RunnerClient, ThreadHostError>;
  /** Drops `client` after a request through it failed; the next caller reconnects. */
  readonly invalidate: (client: RunnerClient) => Effect.Effect<void>;
  /** Waits while the socket is closed for idleness; returns once something reconnects. */
  readonly awaitDemand: Effect.Effect<void>;
  /** Provider processes keep the VM awake for as long as they live. */
  readonly retainPipe: () => void;
  readonly releasePipe: () => void;
  /** Terminal input and output keep the VM awake for a while. */
  readonly notePtyActivity: () => void;
  readonly closeIfIdle: Effect.Effect<boolean>;
  /** True once the VM is known to be terminated; the host then launches a new one. */
  readonly gone: () => boolean;
  readonly checkGone: Effect.Effect<boolean>;
  readonly close: Effect.Effect<void>;
}

interface ActiveConnection {
  readonly client: RunnerClient;
  readonly scope: Scope.Closeable;
}

export const makeVmConnection = (
  endpoint: VmEndpoint,
  options: { readonly terminalIdle: Duration.Duration },
) =>
  Effect.gen(function* () {
    const permit = yield* Semaphore.make(1);
    let active: ActiveConnection | null = null;
    let idleClosed = false;
    let demand = Deferred.makeUnsafe<void>();
    let livePipes = 0;
    let lastTerminalActivity = yield* Clock.currentTimeMillis;
    let gone = false;

    const connect = Effect.gen(function* () {
      const target = yield* endpoint.target;
      const scope = yield* Scope.make();
      const client = yield* makeRunnerClient(target).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.andThen((client) =>
          client[THREAD_RUNNER_METHODS.status]().pipe(
            Effect.timeout(FIRST_REQUEST_TIMEOUT),
            Effect.as(client),
          ),
        ),
        Effect.mapError(
          (cause) =>
            new ThreadHostError({
              reason: "connect-failed",
              detail: `Could not reach the runner in ${endpoint.label}.`,
              cause,
            }),
        ),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      return { client, scope } satisfies ActiveConnection;
    });

    const client = permit.withPermit(
      Effect.suspend(() => {
        if (active !== null) return Effect.succeed(active.client);
        return connect.pipe(
          Effect.map((next) => {
            active = next;
            if (idleClosed) {
              idleClosed = false;
              Deferred.doneUnsafe(demand, Exit.void);
              demand = Deferred.makeUnsafe<void>();
            }
            return next.client;
          }),
          Effect.tapError(() =>
            endpoint.isGone.pipe(
              Effect.map((isGone) => {
                gone ||= isGone;
              }),
            ),
          ),
        );
      }),
    );

    const closeActive = Effect.suspend(() => {
      const closing = active;
      active = null;
      return closing === null ? Effect.void : Scope.close(closing.scope, Exit.void);
    });

    const closeIfIdle = permit.withPermit(
      Effect.gen(function* () {
        if (active === null || livePipes > 0) return false;
        const now = yield* Clock.currentTimeMillis;
        if (now - lastTerminalActivity < Duration.toMillis(options.terminalIdle)) return false;
        idleClosed = true;
        yield* closeActive;
        return true;
      }),
    );

    return {
      label: endpoint.label,
      client,
      invalidate: (failed) =>
        permit.withPermit(
          Effect.suspend(() => (active?.client === failed ? closeActive : Effect.void)),
        ),
      awaitDemand: Effect.suspend(() => (idleClosed ? Deferred.await(demand) : Effect.void)),
      retainPipe: () => {
        livePipes += 1;
      },
      releasePipe: () => {
        livePipes = Math.max(0, livePipes - 1);
      },
      notePtyActivity: () => {
        lastTerminalActivity = Date.now();
      },
      closeIfIdle,
      gone: () => gone,
      checkGone: endpoint.isGone.pipe(
        Effect.map((isGone) => {
          gone ||= isGone;
          return gone;
        }),
      ),
      close: permit.withPermit(closeActive),
    } satisfies VmConnection;
  });
