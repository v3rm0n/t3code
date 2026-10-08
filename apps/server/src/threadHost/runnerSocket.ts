/**
 * Opens an RPC client to a thread runner. Through a MicroVM endpoint the
 * upgrade carries Lambda's auth token and target port as headers; the runner
 * checks its own per-VM secret header.
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";
import { RpcClient, RpcSerialization } from "effect/rpc";

import {
  THREAD_RUNNER_RPC_PATH,
  THREAD_RUNNER_RPC_PORT,
  THREAD_RUNNER_SECRET_HEADER,
  ThreadRunnerRpcGroup,
} from "@t3tools/contracts/threadRunner";

export interface RunnerTarget {
  /** `wss://<microvm endpoint>`, or a plain `ws://` URL for a local runner. */
  readonly baseUrl: string;
  readonly runnerSecret: string;
  /** Headers from CreateMicrovmAuthToken; absent for a local runner. */
  readonly authHeaders?: Readonly<Record<string, string>> | undefined;
}

const socketHeaders = (target: RunnerTarget): Record<string, string> => ({
  [THREAD_RUNNER_SECRET_HEADER]: target.runnerSecret,
  ...(target.authHeaders === undefined
    ? {}
    : { ...target.authHeaders, "X-aws-proxy-port": String(THREAD_RUNNER_RPC_PORT) }),
});

const layerProtocol = (target: RunnerTarget) =>
  Layer.effect(
    RpcClient.Protocol,
    // Reconnects are the caller's job: each one needs a fresh auth token.
    RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) }),
  ).pipe(
    Layer.provide(
      Layer.effect(
        Socket.Socket,
        // Resuming a suspended VM holds the upgrade until the VM is back.
        Socket.makeWebSocket(`${target.baseUrl}${THREAD_RUNNER_RPC_PATH}`, {
          openTimeout: "90 seconds",
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        Socket.WebSocketConstructor,
        (url) => new NodeSocket.NodeWS.WebSocket(url, { headers: socketHeaders(target) }),
      ),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );

/** A runner client whose socket lives as long as the caller's scope. */
export const makeRunnerClient = (target: RunnerTarget) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(layerProtocol(target));
    return yield* RpcClient.make(ThreadRunnerRpcGroup).pipe(Effect.provide(protocol));
  });

export type RunnerClient = Effect.Success<ReturnType<typeof makeRunnerClient>>;
