import { Rpc } from "effect/unstable/rpc";
import { Schema } from "effect";

import { ProviderId } from "./agent.ts";
import { Chat, Message, ResumeStrategy, Session } from "./session.ts";
import { Worktree } from "./worktree.ts";
import { Folder } from "./workspace.ts";

export class ExternalThread extends Schema.Class<ExternalThread>(
  "ExternalThread",
)({
  id: Schema.String,
  providerId: ProviderId,
  title: Schema.String,
  preview: Schema.String,
  projectPath: Schema.String,
  projectName: Schema.String,
  updatedAt: Schema.DateFromString,
  sourcePath: Schema.NullOr(Schema.String),
  cursor: Schema.String,
  resumeStrategy: ResumeStrategy,
  available: Schema.Boolean,
}) {}

export const ContinueExternalThreadInput = Schema.Struct({
  providerId: ProviderId,
  cursor: Schema.String,
  projectPath: Schema.String,
  title: Schema.optional(Schema.String),
  sourcePath: Schema.optional(Schema.NullOr(Schema.String)),
});
export type ContinueExternalThreadInput =
  typeof ContinueExternalThreadInput.Type;

export class ContinueExternalThreadResult extends Schema.Class<ContinueExternalThreadResult>(
  "ContinueExternalThreadResult",
)({
  project: Folder,
  worktree: Schema.NullOr(Worktree),
  chat: Chat,
  session: Session,
  messages: Schema.Array(Message),
}) {}

export const ExternalThreadsListRpc = Rpc.make("externalThreads.list", {
  payload: Schema.Struct({
    limit: Schema.optional(Schema.Number),
  }),
  success: Schema.Array(ExternalThread),
});

export const ExternalThreadsContinueRpc = Rpc.make("externalThreads.continue", {
  payload: ContinueExternalThreadInput,
  success: ContinueExternalThreadResult,
});
