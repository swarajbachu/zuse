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
	kiro: "Kiro",
};

export const providerLabel = (providerId: ProviderId): string =>
	PROVIDER_LABELS[providerId];
