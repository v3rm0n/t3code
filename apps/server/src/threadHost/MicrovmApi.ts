/**
 * The Lambda MicroVM calls a thread host makes. In a multi-tenant deployment
 * these move behind a broker, because IAM cannot limit a tenant's role to its
 * own VMs; the shape here is what that broker would expose.
 */
import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import {
  THREAD_RUNNER_RPC_PORT,
  type ThreadRunnerRunPayload,
} from "@t3tools/contracts/threadRunner";

import type { MicrovmSettings } from "./ThreadHostConfig.ts";
import { ThreadHostError } from "./ThreadHostError.ts";

/** Lambda's lifetime cap: running plus suspended time. */
const MAXIMUM_DURATION_SECONDS = 28_800;
const RUNNING_TIMEOUT = Duration.minutes(3);
const TOKEN_LIFETIME_MINUTES = 60;

export interface LaunchedMicrovm {
  readonly microvmId: string;
  readonly endpoint: string;
}

export interface MicrovmApi {
  readonly launch: (input: {
    readonly payload: ThreadRunnerRunPayload;
    readonly idempotencyKey: string;
  }) => Effect.Effect<LaunchedMicrovm, ThreadHostError>;
  readonly authHeaders: (
    microvmId: string,
  ) => Effect.Effect<Record<string, string>, ThreadHostError>;
  readonly isGone: (microvmId: string) => Effect.Effect<boolean>;
  readonly terminate: (microvmId: string) => Effect.Effect<void>;
}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const makeMicrovmApi = (settings: MicrovmSettings): MicrovmApi => {
  const client = new LambdaMicrovmsClient({ region: settings.region });

  const send = <A>(reason: ThreadHostError["reason"], label: string, call: () => Promise<A>) =>
    Effect.tryPromise({
      try: call,
      catch: (cause) =>
        new ThreadHostError({ reason, detail: `${label}: ${describe(cause)}`, cause }),
    });

  const getMicrovm = (microvmId: string) =>
    send("connect-failed", "GetMicrovm", () =>
      client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId })),
    );

  const waitForRunning = (microvmId: string) =>
    Effect.gen(function* () {
      for (;;) {
        const vm = yield* getMicrovm(microvmId);
        if (vm.state === "RUNNING" && vm.endpoint) return vm.endpoint;
        if (vm.state === "TERMINATING" || vm.state === "TERMINATED") {
          return yield* new ThreadHostError({
            reason: "launch-failed",
            detail: `MicroVM ${microvmId} ended before running: ${vm.stateReason ?? "no reason given"}`,
          });
        }
        yield* Effect.sleep(Duration.seconds(1));
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: RUNNING_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new ThreadHostError({
              reason: "launch-failed",
              detail: `MicroVM ${microvmId} did not reach RUNNING within ${Duration.format(RUNNING_TIMEOUT)}.`,
            }),
          ),
      }),
    );

  return {
    launch: ({ payload, idempotencyKey }) =>
      Effect.gen(function* () {
        const launched = yield* send("launch-failed", "RunMicrovm", () =>
          client.send(
            new RunMicrovmCommand({
              imageIdentifier: settings.imageArn,
              executionRoleArn: settings.executionRoleArn,
              ingressNetworkConnectors: [
                `arn:aws:lambda:${settings.region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
              ],
              egressNetworkConnectors: [settings.egressConnectorArn],
              idlePolicy: {
                autoResumeEnabled: true,
                maxIdleDurationSeconds: settings.maxIdleSeconds,
                suspendedDurationSeconds: settings.suspendedSeconds,
              },
              maximumDurationInSeconds: MAXIMUM_DURATION_SECONDS,
              ...(settings.logGroup === undefined
                ? {}
                : { logging: { cloudWatch: { logGroup: settings.logGroup } } }),
              runHookPayload: JSON.stringify(payload),
              clientToken: idempotencyKey,
            }),
          ),
        );
        const microvmId = launched.microvmId;
        if (!microvmId) {
          return yield* new ThreadHostError({
            reason: "launch-failed",
            detail: "RunMicrovm returned no MicroVM id.",
          });
        }
        const endpoint = yield* waitForRunning(microvmId);
        return { microvmId, endpoint };
      }),
    authHeaders: (microvmId) =>
      send("connect-failed", "CreateMicrovmAuthToken", () =>
        client.send(
          new CreateMicrovmAuthTokenCommand({
            microvmIdentifier: microvmId,
            expirationInMinutes: TOKEN_LIFETIME_MINUTES,
            allowedPorts: [{ port: THREAD_RUNNER_RPC_PORT }],
          }),
        ),
      ).pipe(Effect.map((response) => response.authToken ?? {})),
    isGone: (microvmId) =>
      getMicrovm(microvmId).pipe(
        Effect.map((vm) => vm.state === "TERMINATING" || vm.state === "TERMINATED"),
        // An unknown id is as gone as a terminated one; transient failures are not.
        Effect.catch((error) => Effect.succeed(error.detail.includes("ResourceNotFound"))),
      ),
    terminate: (microvmId) =>
      send("connect-failed", "TerminateMicrovm", () =>
        client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId })),
      ).pipe(Effect.ignore),
  };
};
