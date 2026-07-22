import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { AnalyticsService } from "../analytics/services/analytics-service.ts";
import { FileSearchService } from "./services/file-search.ts";
import { FolderPicker } from "./services/folder-picker.ts";
import { ProjectScaffold } from "./services/project-scaffold.ts";
import { WorkspaceService } from "./services/workspace-service.ts";

const Add = MemoizeRpcs.toLayerHandler("workspace.add", ({ path }) =>
	Effect.gen(function* () {
		const ws = yield* WorkspaceService;
		const analytics = yield* AnalyticsService;
		const result = yield* ws.add(path);
		yield* analytics.capture("project added", {
			source: "folder",
		});
		return result;
	}),
);

const List = MemoizeRpcs.toLayerHandler("workspace.list", () =>
	Effect.flatMap(WorkspaceService, (ws) => ws.list()),
);

const Remove = MemoizeRpcs.toLayerHandler("workspace.remove", ({ folderId }) =>
	Effect.gen(function* () {
		const ws = yield* WorkspaceService;
		const analytics = yield* AnalyticsService;
		const result = yield* ws.remove(folderId);
		yield* analytics.capture("project removed");
		return result;
	}),
);

// Folder picking is a host-shell operation. The server only knows the tag —
// the Electron shim (or any other host) provides the live impl. Keeps this
// handler — and apps/server as a whole — free of UI-toolkit imports.
const PickFolder = MemoizeRpcs.toLayerHandler("workspace.pickFolder", () =>
  Effect.flatMap(FolderPicker, (picker) => picker.pick()),
);

const GetSelected = MemoizeRpcs.toLayerHandler("workspace.getSelected", () =>
  Effect.flatMap(WorkspaceService, (ws) => ws.getSelected()),
);

const SetSelected = MemoizeRpcs.toLayerHandler(
  "workspace.setSelected",
  ({ folderId }) =>
    Effect.flatMap(WorkspaceService, (ws) => ws.setSelected(folderId)),
);

const SearchFiles = MemoizeRpcs.toLayerHandler(
  "workspace.searchFiles",
  ({ projectId, query, limit, worktreeId }) =>
    Effect.flatMap(FileSearchService, (svc) =>
      svc.search(projectId, query, limit, worktreeId ?? null),
    ),
);

// Clone → register pipeline. The scaffold service produces the absolute
// path of the new working tree, then we hand it to `WorkspaceService.add`
// for SQLite registration + the standard sidebar/code-index side effects.
const CloneRepo = MemoizeRpcs.toLayerHandler(
  "workspace.cloneRepo",
  ({ url, parent }) =>
    Effect.gen(function* () {
      const scaffold = yield* ProjectScaffold;
      const ws = yield* WorkspaceService;
      const path = yield* scaffold.cloneRepo(url, parent);
      return yield* ws.add(path);
    }),
);

// Scaffold → register pipeline. Same shape as CloneRepo. We coerce the
// optional `alsoCreateGithubRepo` to a definite boolean here so the
// scaffold service never has to worry about `undefined`.
const CreateProject = MemoizeRpcs.toLayerHandler(
  "workspace.createProject",
  ({ name, parent, template, alsoCreateGithubRepo }) =>
    Effect.gen(function* () {
      const scaffold = yield* ProjectScaffold;
      const ws = yield* WorkspaceService;
      const path = yield* scaffold.createFromTemplate(
        name,
        parent,
        template,
        alsoCreateGithubRepo === true,
      );
      return yield* ws.add(path);
    }),
);

// `gh repo list` proxy for the Clone dialog's recents list. Returns an
// empty array for any failure — the renderer treats the empty case as
// "show a sign-in hint."
const ListGithubRepos = MemoizeRpcs.toLayerHandler(
  "workspace.listGithubRepos",
  ({ limit }) =>
		Effect.flatMap(ProjectScaffold, (svc) => svc.listGithubRepos(limit ?? 30)),
);

const GhAuthStatus = MemoizeRpcs.toLayerHandler("workspace.ghAuthStatus", () =>
	Effect.flatMap(ProjectScaffold, (svc) => svc.ghAuthStatus()),
);

export const WorkspaceHandlersLayer = Layer.mergeAll(
  Add,
  List,
  Remove,
  PickFolder,
  GetSelected,
  SetSelected,
  SearchFiles,
  CloneRepo,
  CreateProject,
  ListGithubRepos,
  GhAuthStatus,
);
