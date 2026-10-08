/**
 * Connects to a thread runner's RPC WebSocket. Through a MicroVM endpoint the
 * headers carry Lambda's auth token and target port; the runner itself checks
 * the per-VM secret header.
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

export interface RunnerConnection {
  /** `wss://<endpoint>` for a MicroVM, or `ws://127.0.0.1:<port>` locally. */
  readonly baseUrl: string;
  readonly runnerSecret: string;
  /** Headers from CreateMicrovmAuthToken; omit when talking to a local runner. */
  readonly microvmAuthHeaders?: Readonly<Record<string, string>> | undefined;
}

export const runnerSocketHeaders = (connection: RunnerConnection): Record<string, string> => ({
  [THREAD_RUNNER_SECRET_HEADER]: connection.runnerSecret,
  ...(connection.microvmAuthHeaders === undefined
    ? {}
    : { ...connection.microvmAuthHeaders, "X-aws-proxy-port": String(THREAD_RUNNER_RPC_PORT) }),
});

const layerProtocol = (connection: RunnerConnection) =>
  Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) }),
  ).pipe(
    Layer.provide(
      Layer.effect(
        Socket.Socket,
        Socket.makeWebSocket(`${connection.baseUrl}${THREAD_RUNNER_RPC_PATH}`, {
          openTimeout: "30 seconds",
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        Socket.WebSocketConstructor,
        (url) => new NodeSocket.NodeWS.WebSocket(url, { headers: runnerSocketHeaders(connection) }),
      ),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );

/** A scoped runner client; closing the scope closes the socket. */
export const makeRunnerClient = (connection: RunnerConnection) =>
  Effect.gen(function* () {
    // Built into the caller's scope so the socket outlives this constructor.
    const protocol = yield* Layer.build(layerProtocol(connection));
    return yield* RpcClient.make(ThreadRunnerRpcGroup).pipe(Effect.provide(protocol));
  });
