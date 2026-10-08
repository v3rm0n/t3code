/**
 * The terminal PTY adapter, routed by thread host: local node-pty in local
 * mode, the thread's runner otherwise. Setup scripts run through the terminal
 * manager, so they follow the same route.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import { ptyProcessView } from "./RemoteProcessViews.ts";
import { ThreadHost } from "./ThreadHost.ts";

export const layer = Layer.effect(
  PtyAdapter.PtyAdapter,
  Effect.gen(function* () {
    const host = yield* ThreadHost;
    const local = yield* NodePtyAdapter.make();
    if (!host.remote) return local;
    return PtyAdapter.PtyAdapter.of({
      spawn: (input) => {
        const threadId = input.threadId;
        if (threadId === undefined) return local.spawn(input);
        return Effect.gen(function* () {
          const remote = yield* host.prepare(threadId, {
            command: input.shell,
            args: input.args ?? [],
            cwd: input.cwd,
            env: host.environmentFor(input.env),
            pty: { cols: input.cols, rows: input.rows },
          });
          const view = ptyProcessView(remote);
          yield* remote.start();
          return view;
        }).pipe(
          Effect.mapError(
            (cause) =>
              new PtyAdapter.PtySpawnError({ adapter: "thread-host", shell: input.shell, cause }),
          ),
        );
      },
    });
  }),
);
