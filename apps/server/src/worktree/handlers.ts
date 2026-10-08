import { MemoizeRpcs } from "@zuse/contracts";
import { WorktreeService } from "@zuse/git/worktree-service";
import { Effect, Layer, Stream } from "effect";
import { withGitHubActor } from "../git/github-request-scope.ts";

const Create = MemoizeRpcs.toLayerHandler(
	"worktree.create",
	({ projectId, source }) =>
		withGitHubActor(
			Effect.flatMap(WorktreeService, (svc) => svc.create(projectId, source)),
		),
);

const List = MemoizeRpcs.toLayerHandler("worktree.list", ({ projectId }) =>
	withGitHubActor(
		Effect.flatMap(WorktreeService, (svc) => svc.list(projectId)),
	),
);

const Get = MemoizeRpcs.toLayerHandler("worktree.get", ({ worktreeId }) =>
	withGitHubActor(
		Effect.flatMap(WorktreeService, (svc) => svc.get(worktreeId)),
	),
);

const RenameBranch = MemoizeRpcs.toLayerHandler(
	"worktree.renameBranch",
	({ worktreeId, name }) =>
		withGitHubActor(
			Effect.flatMap(WorktreeService, (svc) =>
				svc.renameBranch(worktreeId, name, "manual"),
			),
		),
);

const RerunSetup = MemoizeRpcs.toLayerHandler(
	"worktree.rerunSetup",
	({ worktreeId }) =>
		withGitHubActor(
			Effect.flatMap(WorktreeService, (svc) => svc.rerunSetup(worktreeId)),
		),
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
		withGitHubActor(
			Effect.flatMap(WorktreeService, (svc) => svc.startRun(worktreeId)),
		),
);

const Remove = MemoizeRpcs.toLayerHandler("worktree.remove", ({ worktreeId }) =>
	withGitHubActor(
		Effect.flatMap(WorktreeService, (svc) => svc.remove(worktreeId)),
	),
);

export const WorktreeHandlersLayer = Layer.mergeAll(
	Create,
	List,
	Get,
	RenameBranch,
	RerunSetup,
	SetupStream,
	StartRun,
	Remove,
);
