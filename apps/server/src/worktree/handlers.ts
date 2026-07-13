import { MemoizeRpcs } from "@zuse/contracts";
import { WorktreeService } from "@zuse/git/worktree-service";
import { Effect, Layer, Stream } from "effect";

const Create = MemoizeRpcs.toLayerHandler(
  "worktree.create",
  ({ projectId, source }) =>
    Effect.flatMap(WorktreeService, (svc) => svc.create(projectId, source)),
);

const List = MemoizeRpcs.toLayerHandler("worktree.list", ({ projectId }) =>
  Effect.flatMap(WorktreeService, (svc) => svc.list(projectId)),
);

const Get = MemoizeRpcs.toLayerHandler("worktree.get", ({ worktreeId }) =>
  Effect.flatMap(WorktreeService, (svc) => svc.get(worktreeId)),
);

const RerunSetup = MemoizeRpcs.toLayerHandler(
  "worktree.rerunSetup",
  ({ worktreeId }) =>
    Effect.flatMap(WorktreeService, (svc) => svc.rerunSetup(worktreeId)),
);

const SetupStream = MemoizeRpcs.toLayerHandler(
  "worktree.setupStream",
  ({ worktreeId }) =>
    Stream.unwrap(
      Effect.map(WorktreeService, (svc) => svc.setupStream(worktreeId)),
    ),
);

const StartRun = MemoizeRpcs.toLayerHandler(
  "worktree.startRun",
  ({ worktreeId }) =>
    Effect.flatMap(WorktreeService, (svc) => svc.startRun(worktreeId)),
);

const Remove = MemoizeRpcs.toLayerHandler("worktree.remove", ({ worktreeId }) =>
  Effect.flatMap(WorktreeService, (svc) => svc.remove(worktreeId)),
);

export const WorktreeHandlersLayer = Layer.mergeAll(
  Create,
  List,
  Get,
  RerunSetup,
  SetupStream,
  StartRun,
  Remove,
);
