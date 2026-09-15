import { ExtensionError, MemoizeRpcs } from "@zuse/contracts";
import { WorktreeService } from "@zuse/git/worktree-service";
import { Effect, Layer, Stream } from "effect";
import { WorkspaceService } from "../workspace/services/workspace-service.ts";
import { ExtensionService } from "./services/extension-service.ts";

const withService = <A, E>(
	f: (service: ExtensionService["Service"]) => Effect.Effect<A, E>,
) => Effect.flatMap(ExtensionService, f);

const Catalog = MemoizeRpcs.toLayerHandler("extension.catalog", () =>
	withService((service) => service.catalog()),
);
const CatalogStream = MemoizeRpcs.toLayerHandler(
	"extension.catalog.stream",
	() =>
		Stream.unwrap(Effect.map(ExtensionService, (service) => service.stream())),
);
const SetGlobalEnabled = MemoizeRpcs.toLayerHandler(
	"extension.setGlobalEnabled",
	({ enabled }) =>
		withService((service) =>
			Effect.map(
				service.execute({ _tag: "set-global-enabled", enabled }),
				(result) => {
					if (result._tag !== "catalog")
						throw new Error("Expected extension catalog result.");
					return result.catalog;
				},
			),
		),
);
const Inspect = MemoizeRpcs.toLayerHandler("extension.inspect", ({ source }) =>
	withService((service) => service.inspect(source)),
);
const Install = MemoizeRpcs.toLayerHandler(
	"extension.install",
	({ source, grantedCapabilities }) =>
		withService((service) =>
			Effect.map(
				service.execute({ _tag: "install", source, grantedCapabilities }),
				(result) => {
					if (result._tag !== "item")
						throw new Error("Expected extension item result.");
					return result.item;
				},
			),
		),
);

const Enable = MemoizeRpcs.toLayerHandler("extension.enable", ({ id }) =>
	withService((service) =>
		Effect.map(service.execute({ _tag: "enable", id }), (result) => {
			if (result._tag !== "item")
				throw new Error("Expected extension item result.");
			return result.item;
		}),
	),
);
const Disable = MemoizeRpcs.toLayerHandler("extension.disable", ({ id }) =>
	withService((service) =>
		Effect.map(service.execute({ _tag: "disable", id }), (result) => {
			if (result._tag !== "item")
				throw new Error("Expected extension item result.");
			return result.item;
		}),
	),
);
const Reload = MemoizeRpcs.toLayerHandler("extension.reload", ({ id }) =>
	withService((service) =>
		Effect.map(service.execute({ _tag: "reload", id }), (result) => {
			if (result._tag !== "item")
				throw new Error("Expected extension item result.");
			return result.item;
		}),
	),
);
const Remove = MemoizeRpcs.toLayerHandler(
	"extension.remove",
	({ id, deleteData }) =>
		withService((service) =>
			Effect.asVoid(service.execute({ _tag: "remove", id, deleteData })),
		),
);
const Update = MemoizeRpcs.toLayerHandler(
	"extension.update",
	({ id, grantedCapabilities }) =>
		withService((service) =>
			Effect.map(
				service.execute({ _tag: "update", id, grantedCapabilities }),
				(result) => {
					if (result._tag !== "item")
						throw new Error("Expected extension item result.");
					return result.item;
				},
			),
		),
);
const Logs = MemoizeRpcs.toLayerHandler("extension.logs", ({ id }) =>
	withService((service) => service.logs(id)),
);
const Cancel = MemoizeRpcs.toLayerHandler(
	"extension.cancel",
	({ id, requestId }) =>
		withService((service) => service.cancel(id, requestId)),
);
const Invoke = MemoizeRpcs.toLayerHandler(
	"extension.invoke",
	({ id, method, input, workspace, requestId }) =>
		Effect.gen(function* () {
			if (!workspace)
				return yield* withService((service) =>
					service.invoke(id, method, input, undefined, requestId),
				);
			const folders = yield* WorkspaceService;
			const folder = yield* folders.findById(workspace.projectId);
			if (!folder)
				return yield* new ExtensionError({
					code: "invalid-source",
					extensionId: id,
					reason: "Workspace is unavailable.",
				});
			let workspacePath = folder.path;
			if (workspace.worktreeId) {
				const worktrees = yield* WorktreeService;
				const worktree = yield* worktrees
					.get(workspace.worktreeId)
					.pipe(Effect.catch(() => Effect.succeed(null)));
				if (!worktree || worktree.projectId !== workspace.projectId)
					return yield* new ExtensionError({
						code: "invalid-source",
						extensionId: id,
						reason: "Worktree is unavailable.",
					});
				workspacePath = worktree.path;
			}
			return yield* withService((service) =>
				service.invoke(
					id,
					method,
					input,
					{ ...workspace, workspacePath },
					requestId,
				),
			);
		}),
);
const MarketplaceList = MemoizeRpcs.toLayerHandler(
	"extension.marketplace.list",
	() => withService((service) => service.marketplace(false)),
);
const MarketplaceRefresh = MemoizeRpcs.toLayerHandler(
	"extension.marketplace.refresh",
	() => withService((service) => service.marketplace(true)),
);

export const ExtensionHandlersLayer = Layer.mergeAll(
	Catalog,
	CatalogStream,
	SetGlobalEnabled,
	Inspect,
	Install,
	Enable,
	Disable,
	Reload,
	Remove,
	Update,
	Logs,
	Invoke,
	Cancel,
	MarketplaceList,
	MarketplaceRefresh,
);
