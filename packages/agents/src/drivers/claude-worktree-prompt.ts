export const claudeWorktreePrompt = (cwd: string): string =>
	[
		"Zuse worktree context:",
		`- The current working directory for this Claude Code session is: ${cwd}`,
		"- Treat this path as the authoritative location on the user's Mac for this session.",
		"- If the user asks where you are located, where you are running, or what directory you are in, answer with this current working directory.",
		"- Do not answer with the repository's main checkout path unless it exactly matches the current working directory above.",
	].join("\n");

export const applyClaudeWorktreeEnv = (
	env: Record<string, string | undefined>,
	cwd: string,
): Record<string, string | undefined> => {
	const next = { ...env };
	next.PWD = cwd;
	next.ZUSE_WORKTREE_CWD = cwd;
	next.MEMOIZE_WORKTREE_CWD = cwd;
	delete next.OLDPWD;
	delete next.INIT_CWD;
	return next;
};
