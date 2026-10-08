import * as Schema from "effect/Schema";

export const ThreadHostErrorReason = Schema.Literals([
  /** The thread's working directory is not on the volume its VM mounts. */
  "outside-shared-dir",
  "launch-failed",
  "connect-failed",
  "vm-gone",
  "spawn-failed",
  "runner-request-failed",
]);
export type ThreadHostErrorReason = typeof ThreadHostErrorReason.Type;

export class ThreadHostError extends Schema.TaggedError<ThreadHostError>()("ThreadHostError", {
  reason: ThreadHostErrorReason,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Thread host ${this.reason}: ${this.detail}`;
  }
}
