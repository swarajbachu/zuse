// Markers injected by a parent Claude process. Native CLI subprocesses must
// not inherit them or they can resolve auth/session state as a nested call.
const INHERITED_CLAUDE_MARKERS = [
	"CLAUDECODE",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_EXECPATH",
	"CLAUDE_AGENT_SDK_VERSION",
	"CLAUDE_CODE_SESSION_ID",
	"CLAUDE_CODE_SESSION_NAME",
	"CLAUDE_CODE_SESSION_LOG",
] as const;

export const scrubInheritedClaudeMarkers = (
	base: NodeJS.ProcessEnv,
): Record<string, string | undefined> => {
	const next: Record<string, string | undefined> = { ...base };
	for (const key of INHERITED_CLAUDE_MARKERS) delete next[key];
	return next;
};
