import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

describe("AcpSessionRuntime spawn", () => {
  it.effect("runs the agent under the configured wrapper command", () =>
    Effect.gen(function* () {
      const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) {
          spawned.push({ command: command.command, args: command.args });
        }
        return Effect.fail(
          PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }),
        );
      });

      const exit = yield* Layer.build(
        AcpSessionRuntime.layer({
          spawn: {
            command: "grok",
            args: ["agent", "stdio"],
            wrapperCommand: "nono run --profile nolabs-ai/grok --allow-cwd --silent --",
            cwd: "/workspace",
          },
          cwd: "/workspace",
          clientInfo: { name: "t3-code-test", version: "0.0.0" },
        }),
      ).pipe(
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.deepEqual(spawned, [
        {
          command: "nono",
          args: [
            "run",
            "--profile",
            "nolabs-ai/grok",
            "--allow-cwd",
            "--silent",
            "--",
            "grok",
            "agent",
            "stdio",
          ],
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
