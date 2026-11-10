import type { ProviderId } from "../agent.ts";

/**
 * Human-facing provider names. One table shared by the desktop picker, the
 * mobile pickers, and CLI output so a rename lands everywhere at once.
 */
export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
	claude: "Claude Code",
	codex: "Codex",
	grok: "Grok",
	gemini: "Gemini",
	cursor: "Cursor",
	opencode: "OpenCode",
	opencode2: "OpenCode 2",
	kiro: "Kiro",
	pi: "Pi",
	muse: "Muse Code",
	zuse: "Zuse (Experimental)",
};

/** Built-in label, else the catalog's name for a user-configured ACP agent. */
export const providerLabel = (
	providerId: ProviderId,
	displayName?: string,
): string => PROVIDER_LABELS[providerId] ?? displayName ?? "ACP agent";
