const normalizeSlashes = (value: string): string => value.replaceAll("\\", "/");

export const basename = (path: string): string => {
	const normalized = normalizeSlashes(path).replace(/\/$/, "");
	return normalized.slice(normalized.lastIndexOf("/") + 1);
};

export const dirname = (path: string): string => {
	const normalized = normalizeSlashes(path).replace(/\/$/, "");
	const separator = normalized.lastIndexOf("/");
	return separator <= 0 ? "" : normalized.slice(0, separator);
};

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
