// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalConsoleInEffect:off anyUnknownInErrorContext:off globalDate:off globalDateInEffect:off globalTimers:off globalTimersInEffect:off cryptoRandomUUID:off cryptoRandomUUIDInEffect:off preferSchemaOverJson:off - operator script, plain Node at the edges.
/**
 * End-to-end check of the thread-runner VM against real AWS: runs a MicroVM
 * from the spike image, drives the runner over its endpoint, and reports what
 * works (EFS mount, Docker, toolchains, PTY, reattach, suspend/resume) with
 * timings. Run it after `tofu apply`, `create-network-connector.sh`, and
 * `build-thread-image.sh`.
 *
 *   node apps/thread-runner/scripts/spike-check.ts [--keep] [--skip-suspend]
 *   node apps/thread-runner/scripts/spike-check.ts --local ws://127.0.0.1:28080 --secret <secret>
 *
 * AWS credentials and region come from the usual SDK chain (AWS_PROFILE etc.).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { DescribeTasksCommand, ECSClient, ListTasksCommand } from "@aws-sdk/client-ecs";
import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  THREAD_RUNNER_METHODS,
  THREAD_RUNNER_RPC_PORT,
  type ThreadRunnerAttachEvent,
  type ThreadRunnerRunPayload,
  type ThreadRunnerStatus,
} from "@t3tools/contracts/threadRunner";

import { makeRunnerClient, type RunnerConnection } from "./runnerClient.ts";

type RunnerClient = Effect.Success<ReturnType<typeof makeRunnerClient>>;

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly detail: string;
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const repoRoot = NodePath.resolve(import.meta.dirname, "..", "..", "..");
const infraDir = NodePath.resolve(
  option("--infra-dir") ?? NodePath.join(repoRoot, "infra", "aws-microvm-spike"),
);
const stateDir = NodePath.join(infraDir, ".spike");
const results: Array<CheckResult> = [];

const record = (result: CheckResult) => {
  results.push(result);
  const mark = result.ok ? "ok  " : "FAIL";
  console.log(
    `[${mark}] ${result.name} (${result.durationMs} ms) ${result.detail.split("\n")[0] ?? ""}`,
  );
};

const readStateFile = (name: string) => {
  const path = NodePath.join(stateDir, name);
  return NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8").trim() : undefined;
};

const tofuOutputs = (): Record<string, unknown> => {
  const result = NodeChildProcess.spawnSync("tofu", ["output", "-json"], {
    cwd: infraDir,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`tofu output failed in ${infraDir}: ${result.stderr}`);
  const raw = JSON.parse(result.stdout) as Record<string, { value: unknown }>;
  return Object.fromEntries(Object.entries(raw).map(([key, entry]) => [key, entry.value]));
};

// --- Runner helpers ---------------------------------------------------------

const decoder = new TextDecoder();
const outputOf = (events: ReadonlyArray<ThreadRunnerAttachEvent>) =>
  events.map((event) => (event._tag === "Output" ? decoder.decode(event.data) : "")).join("");

interface CommandOutcome {
  readonly exitCode: number | null;
  readonly output: string;
  readonly durationMs: number;
}

/** Runs a bash command in the VM and returns its combined output. */
const runInVm = (client: RunnerClient, command: string, timeout: Duration.Input = "3 minutes") =>
  Effect.gen(function* () {
    const processId = `check-${NodeCrypto.randomUUID()}`;
    const started = Date.now();
    yield* client[THREAD_RUNNER_METHODS.spawn]({
      processId,
      command: "/bin/bash",
      args: ["-c", command],
      env: {},
    });
    const events = yield* Stream.runCollect(
      client[THREAD_RUNNER_METHODS.attach]({ processId, fromOffset: 0 }),
    ).pipe(Effect.timeout(timeout));
    yield* client[THREAD_RUNNER_METHODS.release]({ processId });
    const exit = events.findLast((event) => event._tag === "Exit");
    return {
      exitCode: exit?._tag === "Exit" ? exit.exitCode : null,
      output: outputOf(events).trim(),
      durationMs: Date.now() - started,
    } satisfies CommandOutcome;
  });

const check = (
  name: string,
  client: RunnerClient,
  command: string,
  options: {
    readonly timeout?: Duration.Input;
    readonly expect?: (output: string) => boolean;
  } = {},
) =>
  runInVm(client, command, options.timeout).pipe(
    Effect.map((outcome) =>
      record({
        name,
        ok: outcome.exitCode === 0 && (options.expect?.(outcome.output) ?? true),
        durationMs: outcome.durationMs,
        detail: outcome.output || `(exit ${outcome.exitCode})`,
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.sync(() => record({ name, ok: false, durationMs: 0, detail: String(cause) })),
    ),
  );

const waitForDocker = (client: RunnerClient) =>
  Effect.gen(function* () {
    const started = Date.now();
    let status: ThreadRunnerStatus = yield* client[THREAD_RUNNER_METHODS.status]();
    while (status.docker.state === "starting" && Date.now() - started < 150_000) {
      yield* Effect.sleep("2 seconds");
      status = yield* client[THREAD_RUNNER_METHODS.status]();
    }
    record({
      name: "docker-daemon",
      ok: status.docker.state === "ready",
      durationMs: Date.now() - started,
      detail: `${status.docker.state}${status.docker.detail ? `: ${status.docker.detail}` : ""}`,
    });
    return status.docker.state === "ready";
  });

const checkPty = (client: RunnerClient) =>
  Effect.gen(function* () {
    const processId = `pty-${NodeCrypto.randomUUID()}`;
    const started = Date.now();
    yield* client[THREAD_RUNNER_METHODS.spawn]({
      processId,
      command: "/bin/bash",
      args: ["--noprofile", "--norc", "-i"],
      env: {},
      pty: { cols: 100, rows: 30 },
    });
    yield* client[THREAD_RUNNER_METHODS.write]({
      processId,
      data: new TextEncoder().encode("echo pty-$((40 + 2)); exit\n"),
    });
    const events = yield* Stream.runCollect(
      client[THREAD_RUNNER_METHODS.attach]({ processId, fromOffset: 0 }),
    ).pipe(Effect.timeout("30 seconds"));
    yield* client[THREAD_RUNNER_METHODS.release]({ processId });
    record({
      name: "pty-terminal",
      ok: outputOf(events).includes("pty-42"),
      durationMs: Date.now() - started,
      detail: JSON.stringify(outputOf(events).slice(-120)),
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() =>
        record({ name: "pty-terminal", ok: false, durationMs: 0, detail: String(cause) }),
      ),
    ),
  );

/** Reads part of a process's output, drops the connection, and resumes on a new one. */
const checkReattach = (
  connect: () => Effect.Effect<RunnerClient, unknown, import("effect/Scope").Scope>,
) =>
  Effect.gen(function* () {
    const processId = `ticks-${NodeCrypto.randomUUID()}`;
    const started = Date.now();
    const firstHalf = yield* Effect.gen(function* () {
      const client = yield* connect();
      yield* client[THREAD_RUNNER_METHODS.spawn]({
        processId,
        command: "/bin/bash",
        args: ["-c", "for i in 1 2 3 4 5 6; do echo tick-$i; sleep 1; done"],
        env: {},
      });
      return yield* Stream.runCollect(
        client[THREAD_RUNNER_METHODS.attach]({ processId, fromOffset: 0 }).pipe(
          Stream.takeUntil(
            (event) => event._tag === "Output" && decoder.decode(event.data).includes("tick-2"),
          ),
        ),
      );
    }).pipe(Effect.scoped);
    const resumeFrom = firstHalf.reduce(
      (offset, event) => (event._tag === "Output" ? event.offset + event.data.byteLength : offset),
      0,
    );
    const secondHalf = yield* Effect.gen(function* () {
      const client = yield* connect();
      const events = yield* Stream.runCollect(
        client[THREAD_RUNNER_METHODS.attach]({ processId, fromOffset: resumeFrom }),
      ).pipe(Effect.timeout("30 seconds"));
      yield* client[THREAD_RUNNER_METHODS.release]({ processId });
      return events;
    }).pipe(Effect.scoped);
    const ticks = (outputOf(firstHalf) + outputOf(secondHalf)).match(/tick-\d/g) ?? [];
    record({
      name: "reattach-after-disconnect",
      ok: ticks.join(",") === "tick-1,tick-2,tick-3,tick-4,tick-5,tick-6",
      durationMs: Date.now() - started,
      detail: `resumed at byte ${resumeFrom}; saw ${ticks.join(",")}`,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() =>
        record({
          name: "reattach-after-disconnect",
          ok: false,
          durationMs: 0,
          detail: String(cause),
        }),
      ),
    ),
  );

const runChecks = (
  connect: () => Effect.Effect<RunnerClient, unknown, import("effect/Scope").Scope>,
  options: {
    readonly vmId: string;
    readonly workspace: boolean;
    readonly serverUrl?: string | undefined;
  },
) =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const client = yield* connect();
      const status = yield* client[THREAD_RUNNER_METHODS.status]();
      record({
        name: "runner-status",
        ok: !options.workspace || status.workspace.state === "mounted",
        durationMs: 0,
        detail: `workspace ${status.workspace.state}${status.workspace.detail ? ` (${status.workspace.detail})` : ""}; runner ${status.runnerVersion}`,
      });
      yield* check("identity", client, "id && uname -m && grep PRETTY_NAME /etc/os-release");
      yield* check(
        "toolchains",
        client,
        "node --version && pnpm --version && java -version 2>&1 | head -1 && claude --version && codex --version && gh --version | head -1 && rg --version | head -1 && git --version",
      );
      if (options.workspace) {
        yield* check("workspace-mount", client, "findmnt -no SOURCE,FSTYPE /t3/work");
        yield* check(
          "workspace-write",
          client,
          `mkdir -p /t3/work/spike && echo "written by ${options.vmId} at $(date -Is)" > /t3/work/spike/${options.vmId}.txt && cat /t3/work/spike/${options.vmId}.txt`,
        );
        yield* check(
          "efs-git-clone",
          client,
          "cd /t3/work/spike && rm -rf t3code && TIMEFORMAT='%R s'; time git clone --quiet --depth 1 https://github.com/pingdotgg/t3code.git t3code 2>&1",
          { timeout: "10 minutes" },
        );
        yield* check(
          "efs-git-status",
          client,
          "cd /t3/work/spike/t3code && TIMEFORMAT='%R s'; time git status --porcelain >/dev/null 2>&1",
        );
        yield* check(
          "efs-500-small-files",
          client,
          "cd /t3/work/spike && rm -rf files && mkdir files && TIMEFORMAT='%R s'; time (for i in $(seq 1 500); do echo $i > files/f$i; done; cat files/* >/dev/null)",
        );
      }
      yield* check(
        "local-disk-500-small-files",
        client,
        "cd /var/cache/t3 && rm -rf files && mkdir files && TIMEFORMAT='%R s'; time (for i in $(seq 1 500); do echo $i > files/f$i; done; cat files/* >/dev/null)",
      );
      yield* check(
        "internet-egress",
        client,
        "curl -sS -m 10 -o /dev/null -w '%{http_code}' https://api.anthropic.com/v1/models",
        { expect: (output) => /^\d{3}$/.test(output) },
      );
      if (options.serverUrl) {
        yield* check(
          "server-reachable-from-vm",
          client,
          `curl -sS -m 5 ${options.serverUrl}/.well-known/t3/environment`,
        );
      }
      yield* checkPty(client);
      if (yield* waitForDocker(client)) {
        yield* check(
          "docker-run",
          client,
          "docker run --rm public.ecr.aws/docker/library/alpine:3 echo docker-ok",
          { timeout: "5 minutes", expect: (output) => output.includes("docker-ok") },
        );
      }
    }).pipe(Effect.scoped);
    yield* checkReattach(connect);
  });

// --- Local mode -------------------------------------------------------------

const localMain = (baseUrl: string, secret: string) =>
  runChecks(() => makeRunnerClient({ baseUrl, runnerSecret: secret }), {
    vmId: "local",
    workspace: false,
  });

// --- AWS mode ---------------------------------------------------------------

const awsMain = Effect.gen(function* () {
  const outputs = tofuOutputs();
  const region = String(outputs.region);
  const imageArn =
    process.env.T3_SPIKE_IMAGE_ARN ??
    readStateFile("microvm-image-arn") ??
    String(outputs.microvm_image_arn);
  const connectorArn = process.env.T3_SPIKE_CONNECTOR_ARN ?? readStateFile("network-connector-arn");
  if (!connectorArn) {
    throw new Error(
      "No egress connector ARN. Run infra/aws-microvm-spike/scripts/create-network-connector.sh first.",
    );
  }
  const microvms = new LambdaMicrovmsClient({ region });
  const ecs = new ECSClient({ region });

  const serverUrl = yield* Effect.promise(async () => {
    const cluster = String(outputs.ecs_cluster_name);
    const tasks = await ecs.send(
      new ListTasksCommand({ cluster, serviceName: String(outputs.ecs_service_name) }),
    );
    if (!tasks.taskArns?.length) return undefined;
    const described = await ecs.send(new DescribeTasksCommand({ cluster, tasks: tasks.taskArns }));
    const ip = described.tasks?.[0]?.attachments
      ?.flatMap((attachment) => attachment.details ?? [])
      .find((detail) => detail.name === "privateIPv4Address")?.value;
    return ip ? `http://${ip}:3773` : undefined;
  });

  const runnerSecret = NodeCrypto.randomBytes(32).toString("base64url");
  const mountTargetIps = (outputs.efs_mount_target_ips as ReadonlyArray<string> | undefined) ?? [];
  const payload: ThreadRunnerRunPayload = {
    version: 1,
    runnerSecret,
    tenantId: String(outputs.tenant_id),
    threadId: "spike-check",
    workspace: {
      fileSystemId: String(outputs.efs_file_system_id),
      accessPointId: String(outputs.efs_work_access_point_id),
      mountPath: String(outputs.work_mount_path),
      region,
      ...(flag("--mount-by-ip") && mountTargetIps[0] ? { mountTargetIp: mountTargetIps[0] } : {}),
    },
    home: `${String(outputs.work_mount_path)}/home`,
    docker: true,
  };

  const launchStarted = Date.now();
  const launched = yield* Effect.promise(() =>
    microvms.send(
      new RunMicrovmCommand({
        imageIdentifier: imageArn,
        executionRoleArn: String(outputs.microvm_execution_role_arn),
        ingressNetworkConnectors: [
          `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
        ],
        egressNetworkConnectors: [connectorArn],
        idlePolicy: {
          autoResumeEnabled: true,
          maxIdleDurationSeconds: 300,
          suspendedDurationSeconds: 1800,
        },
        maximumDurationInSeconds: 3600,
        logging: { cloudWatch: { logGroup: String(outputs.microvm_log_group) } },
        runHookPayload: JSON.stringify(payload),
        clientToken: NodeCrypto.randomUUID(),
      }),
    ),
  );
  const vmId = launched.microvmId ?? "unknown";
  console.log(`MicroVM ${vmId} launched`);

  const waitForState = (wanted: string, limitMs: number) =>
    Effect.gen(function* () {
      const started = Date.now();
      for (;;) {
        const vm = yield* Effect.promise(() =>
          microvms.send(new GetMicrovmCommand({ microvmIdentifier: vmId })),
        );
        if (vm.state === wanted) return { endpoint: vm.endpoint, elapsedMs: Date.now() - started };
        if (vm.state === "TERMINATED" || Date.now() - started > limitMs) {
          throw new Error(
            `MicroVM ${vmId} is ${vm.state}, wanted ${wanted}: ${vm.stateReason ?? "no reason given"}`,
          );
        }
        yield* Effect.sleep("1 second");
      }
    });

  const running = yield* waitForState("RUNNING", 180_000);
  record({
    name: "run-to-running",
    ok: true,
    durationMs: Date.now() - launchStarted,
    detail: running.endpoint ?? "",
  });

  const connect = () =>
    Effect.gen(function* () {
      const token = yield* Effect.promise(() =>
        microvms.send(
          new CreateMicrovmAuthTokenCommand({
            microvmIdentifier: vmId,
            expirationInMinutes: 30,
            allowedPorts: [{ port: THREAD_RUNNER_RPC_PORT }],
          }),
        ),
      );
      const connection: RunnerConnection = {
        baseUrl: `wss://${running.endpoint}`,
        runnerSecret,
        microvmAuthHeaders: token.authToken ?? {},
      };
      return yield* makeRunnerClient(connection);
    });

  yield* runChecks(connect, { vmId, workspace: true, serverUrl });

  if (!flag("--skip-suspend")) {
    // Leave a process running, suspend, then let the next connection auto-resume.
    const keeperId = `keeper-${NodeCrypto.randomUUID()}`;
    yield* Effect.gen(function* () {
      const client = yield* connect();
      yield* client[THREAD_RUNNER_METHODS.spawn]({
        processId: keeperId,
        command: "sleep",
        args: ["7200"],
        env: {},
      });
    }).pipe(Effect.scoped);
    const suspendStarted = Date.now();
    yield* Effect.promise(() =>
      microvms.send(new SuspendMicrovmCommand({ microvmIdentifier: vmId })),
    );
    yield* waitForState("SUSPENDED", 180_000);
    record({
      name: "suspend",
      ok: true,
      durationMs: Date.now() - suspendStarted,
      detail: "SUSPENDED",
    });

    const resumeStarted = Date.now();
    yield* Effect.gen(function* () {
      const client = yield* connect();
      const status = yield* client[THREAD_RUNNER_METHODS.status]();
      const keeper = status.processes.find((process) => process.processId === keeperId);
      record({
        name: "auto-resume-on-connect",
        ok: keeper !== undefined && keeper.exit === null,
        durationMs: Date.now() - resumeStarted,
        detail: keeper ? `sleep pid ${keeper.pid} still running` : "process lost across suspend",
      });
      yield* check("workspace-after-resume", client, `cat /t3/work/spike/${vmId}.txt`);
      yield* client[THREAD_RUNNER_METHODS.release]({ processId: keeperId });
    }).pipe(
      Effect.scoped,
      Effect.catchCause((cause) =>
        Effect.sync(() =>
          record({
            name: "auto-resume-on-connect",
            ok: false,
            durationMs: Date.now() - resumeStarted,
            detail: String(cause),
          }),
        ),
      ),
    );
  }

  if (flag("--keep")) {
    console.log(
      `Keeping ${vmId}. Terminate it with: aws lambda-microvms terminate-microvm --microvm-identifier ${vmId}`,
    );
  } else {
    yield* Effect.promise(() =>
      microvms.send(new TerminateMicrovmCommand({ microvmIdentifier: vmId })),
    );
  }

  console.log(
    `\nCross-check from the server task:\n  aws ecs execute-command --cluster ${String(outputs.ecs_cluster_name)} --task <task-id> --container server --interactive --command "cat /t3/work/spike/${vmId}.txt"`,
  );
  return vmId;
});

// --- Entry ------------------------------------------------------------------

const localUrl = option("--local");
const program = localUrl
  ? localMain(localUrl, option("--secret") ?? "").pipe(Effect.as("local"))
  : awsMain;

const finish = (label: string) => {
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (!localUrl) {
    NodeFS.mkdirSync(stateDir, { recursive: true });
    const reportPath = NodePath.join(stateDir, `spike-report-${label}.json`);
    NodeFS.writeFileSync(reportPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`Report: ${reportPath}`);
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
};

Effect.runPromise(
  program.pipe(
    Effect.asSome,
    Effect.catchCause((cause) => {
      console.error(String(cause));
      return Effect.succeed(Option.none<string>());
    }),
  ),
).then((label) => finish(Option.getOrElse(label, () => "failed")));
