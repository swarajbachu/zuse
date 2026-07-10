import { Rpc } from "effect/unstable/rpc";
import { Schema } from "effect";

import { FsFolderNotFoundError } from "./fs.ts";
import { FolderId, WorktreeId } from "./ids.ts";

export class Folder extends Schema.Class<Folder>("Folder")({
  id: FolderId,
  path: Schema.String,
  name: Schema.String,
  addedAt: Schema.DateFromString,
}) {}

export class WorkspaceDuplicatePathError extends Schema.TaggedErrorClass<WorkspaceDuplicatePathError>()(
  "WorkspaceDuplicatePathError",
  { path: Schema.String },
) {}

export class WorkspaceNotFoundError extends Schema.TaggedErrorClass<WorkspaceNotFoundError>()(
  "WorkspaceNotFoundError",
  { folderId: FolderId },
) {}

export class WorkspaceInvalidPathError extends Schema.TaggedErrorClass<WorkspaceInvalidPathError>()(
  "WorkspaceInvalidPathError",
  { path: Schema.String, reason: Schema.String },
) {}

/**
 * Returned when `git clone` (or any prerequisite step like resolving the
 * derived folder name, or creating the parent dir) fails. `reason` carries
 * trimmed stderr or a human-readable explanation; the renderer surfaces it
 * inline under the URL field.
 */
export class WorkspaceCloneFailedError extends Schema.TaggedErrorClass<WorkspaceCloneFailedError>()(
  "WorkspaceCloneFailedError",
  { url: Schema.String, reason: Schema.String },
) {}

/**
 * Returned when template scaffolding fails. `step` is "mkdir" | "git-init"
 * | "template" | "install" | "gh-create" — lets the dialog point the user
 * at the right corrective action. `reason` is trimmed stderr.
 */
export class WorkspaceCreateFailedError extends Schema.TaggedErrorClass<WorkspaceCreateFailedError>()(
  "WorkspaceCreateFailedError",
  {
    name: Schema.String,
    step: Schema.Literals(["mkdir", "git-init", "template", "install", "gh-create"]),
    reason: Schema.String,
  },
) {}

/**
 * One entry in the Clone-dialog's recents list. Populated by
 * `workspace.listGithubRepos` which shells out to `gh repo list --json`.
 * `sshUrl` is preferred when the user has SSH keys; `httpsUrl` is the
 * gh-CLI-friendly fallback.
 */
export class GithubRepoSummary extends Schema.Class<GithubRepoSummary>(
  "GithubRepoSummary",
)({
  nameWithOwner: Schema.String,
  description: Schema.NullOr(Schema.String),
  sshUrl: Schema.String,
  httpsUrl: Schema.String,
  isPrivate: Schema.Boolean,
  updatedAt: Schema.DateFromString,
}) {}

/**
 * Identifier for the "Quick start" template grid. Adding a card later is
 * a one-line change here + a new branch in `project-scaffold-live.ts`.
 */
export const ProjectTemplate = Schema.Literals(["empty", "nextjs", "turborepo"]);
export type ProjectTemplate = typeof ProjectTemplate.Type;

export const WorkspaceAddRpc = Rpc.make("workspace.add", {
  payload: Schema.Struct({ path: Schema.String }),
  success: Folder,
  error: Schema.Union([WorkspaceDuplicatePathError, WorkspaceInvalidPathError]),
});

export const WorkspaceListRpc = Rpc.make("workspace.list", {
  payload: Schema.Struct({}),
  success: Schema.Array(Folder),
});

export const WorkspaceRemoveRpc = Rpc.make("workspace.remove", {
  payload: Schema.Struct({ folderId: FolderId }),
  success: Schema.Void,
  error: WorkspaceNotFoundError,
});

export const WorkspacePickFolderRpc = Rpc.make("workspace.pickFolder", {
  payload: Schema.Struct({}),
  success: Schema.NullOr(Schema.String),
});

export const WorkspaceGetSelectedRpc = Rpc.make("workspace.getSelected", {
  payload: Schema.Struct({}),
  success: Schema.NullOr(FolderId),
});

export const WorkspaceSetSelectedRpc = Rpc.make("workspace.setSelected", {
  payload: Schema.Struct({ folderId: Schema.NullOr(FolderId) }),
  success: Schema.Void,
});

/**
 * Clone a public/private repo into `<parent>/<derived-name>` and register
 * the result as a workspace folder. Folder name is derived from the URL's
 * last path segment with `.git` stripped — server fails with
 * `WorkspaceCloneFailedError` if the derivation is empty.
 *
 * The handler chains: derive name → ensure target doesn't already exist →
 * `git clone --progress <url> <parent>/<name>` → `WorkspaceService.add`.
 * A `null` or empty `parent` means "use a sensible default" (resolved on
 * the server: `~/Developer` if it exists, else home).
 */
export const WorkspaceCloneRepoRpc = Rpc.make("workspace.cloneRepo", {
  payload: Schema.Struct({
    url: Schema.String,
    parent: Schema.String,
  }),
  success: Folder,
  error: Schema.Union([
    WorkspaceCloneFailedError,
    WorkspaceInvalidPathError,
    WorkspaceDuplicatePathError,
  ]),
});

/**
 * Create a new project from a template, run `git init`, and register it.
 * `name` is validated (`^[a-z0-9][a-z0-9-_]*$`) so downstream `bunx
 * create-next-app <name>` invocations never reject the argument.
 *
 * `alsoCreateGithubRepo`, when true, runs `gh repo create --private
 * --source . --push` after the scaffold. The renderer only enables the
 * checkbox when `gh` is authenticated — see `workspace.ghAuthStatus`.
 */
export const WorkspaceCreateProjectRpc = Rpc.make("workspace.createProject", {
  payload: Schema.Struct({
    name: Schema.String,
    parent: Schema.String,
    template: ProjectTemplate,
    alsoCreateGithubRepo: Schema.optional(Schema.Boolean),
  }),
  success: Folder,
  error: Schema.Union([
    WorkspaceCreateFailedError,
    WorkspaceInvalidPathError,
    WorkspaceDuplicatePathError,
  ]),
});

/**
 * Returns the signed-in user's GitHub repos (most recently pushed first)
 * for the Clone dialog's "Recent repos" list. Empty array when `gh` is
 * missing, the user isn't signed in, or the call errors — the renderer
 * shows a one-line `gh auth login` hint instead.
 */
export const WorkspaceListGithubReposRpc = Rpc.make(
  "workspace.listGithubRepos",
  {
    payload: Schema.Struct({ limit: Schema.optional(Schema.Number) }),
    success: Schema.Array(GithubRepoSummary),
  },
);

/**
 * Quick "is gh signed in?" probe so the Quick start dialog can disable
 * its "Also create a private GitHub repo" checkbox when it would just
 * fail. Returns `false` for missing gh, signed-out, or any error — the
 * dialog never needs to distinguish.
 */
export const WorkspaceGhAuthStatusRpc = Rpc.make("workspace.ghAuthStatus", {
  payload: Schema.Struct({}),
  success: Schema.Struct({ authenticated: Schema.Boolean }),
});

/**
 * Walk the project's file tree honouring `.gitignore` and return up to
 * `limit` matches against `query`. Backs the composer's `@` file picker.
 * Empty `query` returns the most recently touched entries (server's call).
 *
 * When `worktreeId` is set the walk is rooted at the worktree's path instead
 * of the project's main checkout, so a session running on a worktree only
 * surfaces files that actually live in that worktree. Mirrors the optional
 * `worktreeId` on the `fs.*` RPCs; the server falls back to the project root
 * silently if the worktree doesn't belong to `projectId`.
 */
export const WorkspaceSearchFilesRpc = Rpc.make("workspace.searchFiles", {
  payload: Schema.Struct({
    projectId: FolderId,
    query: Schema.String,
    limit: Schema.optional(Schema.Number),
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: Schema.Array(
    Schema.Struct({
      relPath: Schema.String,
      absPath: Schema.String,
      kind: Schema.Literals(["file", "directory"]),
    }),
  ),
  error: FsFolderNotFoundError,
});
