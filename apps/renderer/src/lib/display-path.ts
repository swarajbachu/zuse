/**
 * Human-friendly path for tooltips and labels. Absolute machine paths are
 * noise — every worktree lives under `~/.zuse/<project>/<worktree>/…`, so a
 * path is shown relative to the first matching workspace root, falling back
 * to stripping the worktree convention prefix, then to `~` for the home dir.
 */
const WORKTREE_ROOT_RE = /\/\.zuse\/[^/]+\/[^/]+\//;
const HOME_RE = /^\/(?:Users|home)\/[^/]+(?=\/)/;

export function displayPath(
  path: string,
  roots?: ReadonlyArray<string | null | undefined>,
): string {
  for (const root of roots ?? []) {
    if (root === null || root === undefined || root === "") continue;
    const clean = root.endsWith("/") ? root.slice(0, -1) : root;
    if (path.startsWith(`${clean}/`)) return path.slice(clean.length + 1);
  }
  const worktree = WORKTREE_ROOT_RE.exec(path);
  if (worktree !== null) {
    const rest = path.slice(worktree.index + worktree[0].length);
    if (rest.length > 0) return rest;
  }
  const home = HOME_RE.exec(path);
  if (home !== null) return `~${path.slice(home[0].length)}`;
  return path;
}
