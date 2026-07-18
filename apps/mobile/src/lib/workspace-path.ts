const normalizeSlashes = (value: string): string => value.replaceAll("\\", "/");

/** Keep filesystem identity private while presenting a workspace-relative path. */
export const workspaceDisplayPath = (
	path: string,
	workspaceRoot?: string | null,
): string => {
	const normalized = normalizeSlashes(path).replace(/^\.\//, "");
	const root =
		workspaceRoot === undefined || workspaceRoot === null
			? null
			: normalizeSlashes(workspaceRoot).replace(/\/$/, "");
	if (root !== null && normalized.startsWith(`${root}/`)) {
		return normalized.slice(root.length + 1);
	}

	const managedWorktree = normalized.match(
		/\/(?:\.zuse)\/[^/]+\/[^/]+\/(.+)$/,
	)?.[1];
	if (managedWorktree !== undefined) return managedWorktree;

	const managedCodexWorktree = normalized.match(
		/\/\.codex\/worktrees\/[^/]+\/[^/]+\/(.+)$/,
	)?.[1];
	if (managedCodexWorktree !== undefined) return managedCodexWorktree;

	return normalized;
};
