import { Context, type Effect } from "effect";

import {
  type GithubRepoSummary,
  type ProjectTemplate,
  type WorkspaceCloneFailedError,
  type WorkspaceCreateFailedError,
  type WorkspaceInvalidPathError,
} from "@zuse/wire";

/**
 * Everything the workspace handlers need to *produce* a project path on
 * disk, before handing the path to the existing `WorkspaceService.add`
 * for SQLite registration + sidebar surfacing.
 *
 * Keeps the shell-out surface (git, gh, bunx) isolated from the
 * SQL-shaped `WorkspaceService`, so we don't have to grow that interface
 * every time we add a template or a remote helper. Also makes mocking
 * trivial in tests: the handler-level integration test can stub this
 * service and assert "the handler passed our fake path to `add`."
 */
export interface ProjectScaffoldShape {
  /** Run `git clone` and return the absolute path of the new working tree. */
  readonly cloneRepo: (
    url: string,
    parent: string,
  ) => Effect.Effect<string, WorkspaceCloneFailedError | WorkspaceInvalidPathError>;

  /**
   * Scaffold a fresh project under `<parent>/<name>` using the named
   * template, `git init` it, and optionally create + push a private
   * GitHub repo. Returns the absolute path. Each failing step maps to
   * `WorkspaceCreateFailedError.step` so the renderer can point the user
   * at the right fix (e.g. "install bun" vs "run gh auth login").
   */
  readonly createFromTemplate: (
    name: string,
    parent: string,
    template: ProjectTemplate,
    alsoCreateGithubRepo: boolean,
  ) => Effect.Effect<
    string,
    WorkspaceCreateFailedError | WorkspaceInvalidPathError
  >;

  /**
   * `gh repo list --json …` for the signed-in user. Returns `[]` for
   * any failure (gh missing, signed-out, network) — the dialog falls
   * back to the URL field and a one-line auth hint.
   */
  readonly listGithubRepos: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<GithubRepoSummary>>;

  /** Best-effort "is gh signed in" probe for enabling the create-repo checkbox. */
  readonly ghAuthStatus: () => Effect.Effect<{ readonly authenticated: boolean }>;
}

export class ProjectScaffold extends Context.Service<
  ProjectScaffold,
  ProjectScaffoldShape
>()("memoize/ProjectScaffold") {}

/**
 * Derive the on-disk folder name from a clone URL. Mirrors `git clone`'s
 * own rule: last path segment, `.git` suffix removed. Returns `null` if
 * we can't pull a usable name (e.g. trailing slashes only) so the
 * handler can surface a clean validation error.
 *
 * Examples:
 *   https://github.com/foo/bar.git    → bar
 *   git@github.com:foo/bar.git        → bar
 *   https://gitlab.com/group/sub/x    → x
 */
export const deriveCloneTargetName = (url: string): string | null => {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  // Strip query/fragment so they don't sneak into the folder name.
  const noQuery = trimmed.split(/[?#]/)[0]!;
  // ssh form `git@host:owner/repo.git` — split on the last colon, keep
  // the path portion.
  const afterColon = noQuery.includes("://")
    ? noQuery.split("://", 2)[1] ?? ""
    : noQuery.includes(":")
      ? noQuery.split(":").slice(1).join(":")
      : noQuery;
  // Drop the host component (first `/`-separated piece) when we still
  // have one after the colon split.
  const path = afterColon.replace(/^[^/]+\//, "");
  const segments = path.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (last === undefined) return null;
  const stripped = last.replace(/\.git$/i, "");
  return stripped.length > 0 ? stripped : null;
};

/**
 * Validate a Quick-start project name. Conservative on purpose so
 * `bunx create-next-app <name>` (and the eventual `gh repo create
 * <name>`) never reject the argument. Shared by the wire handler and
 * the renderer dialog so both error on the same input.
 */
export const PROJECT_NAME_REGEX = /^[a-z0-9][a-z0-9-_]*$/;
export const isValidProjectName = (name: string): boolean =>
  PROJECT_NAME_REGEX.test(name);
