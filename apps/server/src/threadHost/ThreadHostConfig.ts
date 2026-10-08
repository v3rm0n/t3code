/**
 * Where thread processes run. `local` is T3's normal mode. The two remote modes
 * run provider processes, terminals, and setup scripts through a thread runner
 * while git, checkpoints, and files stay on this server, which sees the same
 * files at `T3CODE_SHARED_DIR`:
 *
 * - `microvm`: one Lambda MicroVM per thread, launched on demand.
 * - `runner`: every thread uses one runner at a fixed URL (local development).
 */
import * as Config from "effect/Config";
import * as Option from "effect/Option";

export interface MicrovmSettings {
  readonly region: string;
  readonly imageArn: string;
  readonly egressConnectorArn: string;
  readonly executionRoleArn: string;
  readonly fileSystemId: string;
  readonly accessPointId: string;
  readonly logGroup: string | undefined;
  /** Seconds without endpoint traffic before Lambda suspends a VM. */
  readonly maxIdleSeconds: number;
  /** Seconds a VM stays suspended before Lambda terminates it. */
  readonly suspendedSeconds: number;
}

export type ThreadHostConfig =
  | { readonly kind: "local" }
  | {
      readonly kind: "runner";
      readonly sharedDir: string;
      readonly runnerUrl: string;
      readonly runnerSecret: string;
    }
  | { readonly kind: "microvm"; readonly sharedDir: string; readonly microvm: MicrovmSettings };

const optionalString = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.getOrUndefined));

const requiredString = (name: string) => Config.String(name);

export const ThreadHostConfigFromEnv: Config.Config<ThreadHostConfig> = Config.Literals(
  ["local", "runner", "microvm"],
  "T3CODE_THREAD_HOST",
).pipe(
  Config.withDefault("local" as const),
  Config.flatMap((kind): Config.Config<ThreadHostConfig> => {
    if (kind === "local") return Config.succeed({ kind });
    const sharedDir = requiredString("T3CODE_SHARED_DIR");
    if (kind === "runner") {
      return Config.all({
        sharedDir,
        runnerUrl: requiredString("T3CODE_THREAD_RUNNER_URL"),
        runnerSecret: requiredString("T3CODE_THREAD_RUNNER_SECRET"),
      }).pipe(Config.map((settings) => ({ kind, ...settings })));
    }
    return Config.all({
      sharedDir,
      microvm: Config.all({
        region: requiredString("AWS_REGION"),
        imageArn: requiredString("T3CODE_MICROVM_IMAGE_ARN"),
        egressConnectorArn: requiredString("T3CODE_MICROVM_EGRESS_CONNECTOR_ARN"),
        executionRoleArn: requiredString("T3CODE_MICROVM_EXECUTION_ROLE_ARN"),
        fileSystemId: requiredString("T3CODE_MICROVM_EFS_FILE_SYSTEM_ID"),
        accessPointId: requiredString("T3CODE_MICROVM_EFS_ACCESS_POINT_ID"),
        logGroup: optionalString("T3CODE_MICROVM_LOG_GROUP"),
        maxIdleSeconds: Config.Int("T3CODE_MICROVM_MAX_IDLE_SECONDS").pipe(Config.withDefault(300)),
        suspendedSeconds: Config.Int("T3CODE_MICROVM_SUSPENDED_SECONDS").pipe(
          Config.withDefault(3600),
        ),
      }),
    }).pipe(Config.map((settings) => ({ kind, ...settings })));
  }),
);
