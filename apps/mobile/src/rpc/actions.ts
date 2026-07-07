import type {
  ComposerInput,
  Folder,
  GitBranchInfo,
  GitPrSummary,
  PermissionDecision,
  PermissionMode,
  ProviderId,
  RuntimeMode,
  SessionId,
  Worktree,
  WorktreeCreateSource,
  WorktreeId,
} from "@zuse/wire";
import { Effect } from "effect";

import { getConnectionClient, reportConnectionFailure } from "./connection";
import type { WsProtocolOptions } from "./ws-protocol";

export const makeTextInput = (text: string): ComposerInput => ({
  text,
  attachments: [],
  fileRefs: [],
  skillRefs: [],
  annotations: [],
});

export const sendMessage = (options: {
  connection: WsProtocolOptions;
  sessionId: SessionId;
  input: ComposerInput;
  asGoal?: boolean;
}) => {
  const program = Effect.gen(function* () {
    const client = yield* getConnectionClient(options.connection);
    const payload = {
      sessionId: options.sessionId,
      text: options.input.text,
      ...(options.asGoal === undefined ? {} : { asGoal: options.asGoal }),
    };
    yield* client.messages.send(payload);
  });
  return program.pipe(
    Effect.tapError((cause) =>
      Effect.sync(() => reportConnectionFailure(options.connection, cause))
    )
  );
};

export const interruptSession = (options: {
  connection: WsProtocolOptions;
  sessionId: SessionId;
}) => {
  const program = Effect.gen(function* () {
    const client = yield* getConnectionClient(options.connection);
    yield* client.messages.interrupt({ sessionId: options.sessionId });
  });
  return program.pipe(
    Effect.tapError((cause) =>
      Effect.sync(() => reportConnectionFailure(options.connection, cause))
    )
  );
};

export const decidePermission = (options: {
  connection: WsProtocolOptions;
  requestId: string;
  decision: PermissionDecision;
}) => {
  const program = Effect.gen(function* () {
    const client = yield* getConnectionClient(options.connection);
    yield* client.permission.decide({
      requestId: options.requestId,
      decision: options.decision,
    });
  });
  return program.pipe(
    Effect.tapError((cause) =>
      Effect.sync(() => reportConnectionFailure(options.connection, cause))
    )
  );
};

export const answerQuestion = (options: {
  connection: WsProtocolOptions;
  sessionId: SessionId;
  itemId: string;
  answers: readonly {
    questionIndex: number;
    selected: readonly number[];
    other?: string;
  }[];
}) => {
  const program = Effect.gen(function* () {
    const client = yield* getConnectionClient(options.connection);
    yield* client.session.answerQuestion({
      sessionId: options.sessionId,
      itemId: options.itemId,
      answers: [...options.answers].map((answer) => ({
        questionIndex: answer.questionIndex,
        selected: [...answer.selected],
        other: answer.other,
      })),
    });
  });
  return program.pipe(
    Effect.tapError((cause) =>
      Effect.sync(() => reportConnectionFailure(options.connection, cause))
    )
  );
};

export const createChat = (options: {
  connection: WsProtocolOptions;
  projectId: Folder["id"];
  providerId: ProviderId;
  model: string;
  initialPrompt: string;
  runtimeMode?: RuntimeMode;
  permissionMode?: PermissionMode;
  worktreeId?: WorktreeId | null;
}) => {
  const program = Effect.gen(function* () {
    const client = yield* getConnectionClient(options.connection);
    return yield* client.chat.create({
      projectId: options.projectId,
      providerId: options.providerId,
      model: options.model,
      initialPrompt: options.initialPrompt,
      runtimeMode: options.runtimeMode,
      permissionMode: options.permissionMode,
      worktreeId: options.worktreeId ?? null,
    });
  });
  return program.pipe(
    Effect.tapError((cause) =>
      Effect.sync(() => reportConnectionFailure(options.connection, cause))
    )
  );
};

export const setSessionProvider = (options: {
  connection: WsProtocolOptions;
  sessionId: SessionId;
  providerId: ProviderId;
  model: string;
}) => {
  const program = Effect.gen(function* () {
    const client = yield* getConnectionClient(options.connection);
    yield* client.session.setProvider({
      sessionId: options.sessionId,
      providerId: options.providerId,
      model: options.model,
    });
  });
  return program.pipe(
    Effect.tapError((cause) =>
      Effect.sync(() => reportConnectionFailure(options.connection, cause))
    )
  );
};

export const setSessionModel = (options: {
  connection: WsProtocolOptions;
  sessionId: SessionId;
  model: string;
}) => {
  const program = Effect.gen(function* () {
    const client = yield* getConnectionClient(options.connection);
    yield* client.session.setModel({
      sessionId: options.sessionId,
      model: options.model,
    });
  });
  return program.pipe(
    Effect.tapError((cause) =>
      Effect.sync(() => reportConnectionFailure(options.connection, cause))
    )
  );
};

export const setSessionRuntimeMode = (options: {
  connection: WsProtocolOptions;
  sessionId: SessionId;
  runtimeMode: RuntimeMode;
}) => {
  const program = Effect.gen(function* () {
    const client = yield* getConnectionClient(options.connection);
    yield* client.session.setRuntimeMode({
      sessionId: options.sessionId,
      runtimeMode: options.runtimeMode,
    });
  });
  return program.pipe(
    Effect.tapError((cause) =>
      Effect.sync(() => reportConnectionFailure(options.connection, cause))
    )
  );
};

export const setSessionPermissionMode = (options: {
  connection: WsProtocolOptions;
  sessionId: SessionId;
  mode: PermissionMode;
}) => {
  const program = Effect.gen(function* () {
    const client = yield* getConnectionClient(options.connection);
    yield* client.session.setPermissionMode({
      sessionId: options.sessionId,
      mode: options.mode,
    });
  });
  return program.pipe(
    Effect.tapError((cause) =>
      Effect.sync(() => reportConnectionFailure(options.connection, cause))
    )
  );
};

export const listWorktrees = (options: {
  connection: WsProtocolOptions;
  projectId: Folder["id"];
}) => {
  const program: Effect.Effect<readonly Worktree[], unknown, never> = Effect.gen(function* () {
    const client = yield* getConnectionClient(options.connection);
    return yield* client.worktree.list({ projectId: options.projectId });
  });
  return program.pipe(
    Effect.tapError((cause) =>
      Effect.sync(() => reportConnectionFailure(options.connection, cause))
    )
  );
};

export const createWorktree = (options: {
  connection: WsProtocolOptions;
  projectId: Folder["id"];
  source?: WorktreeCreateSource;
}) => {
  const program: Effect.Effect<Worktree, unknown, never> = Effect.gen(function* () {
    const client = yield* getConnectionClient(options.connection);
    return yield* client.worktree.create({
      projectId: options.projectId,
      source: options.source,
    });
  });
  return program.pipe(
    Effect.tapError((cause) =>
      Effect.sync(() => reportConnectionFailure(options.connection, cause))
    )
  );
};

export const listBranches = (options: {
  connection: WsProtocolOptions;
  projectId: Folder["id"];
}) => {
  const program: Effect.Effect<readonly GitBranchInfo[], unknown, never> = Effect.gen(function* () {
    const client = yield* getConnectionClient(options.connection);
    return yield* client.git.branches({ folderId: options.projectId });
  });
  return program.pipe(
    Effect.catchAll(() => Effect.succeed([])),
  );
};

export const listPullRequests = (options: {
  connection: WsProtocolOptions;
  projectId: Folder["id"];
}) => {
  const program: Effect.Effect<readonly GitPrSummary[], unknown, never> = Effect.gen(function* () {
    const client = yield* getConnectionClient(options.connection);
    return yield* client.git.listPrs({ folderId: options.projectId });
  });
  return program.pipe(
    Effect.catchAll(() => Effect.succeed([])),
  );
};
