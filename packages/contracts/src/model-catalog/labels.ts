import type { BuiltinProviderId, ProviderId } from "../agent.ts";

/**
 * Human-facing provider names. One table shared by the desktop picker, the
 * mobile pickers, and CLI output so a rename lands everywhere at once.
 */
export const PROVIDER_LABELS: Readonly<
	Record<BuiltinProviderId, string> & Partial<Record<ProviderId, string>>
> = {
	claude: "Claude Code",
	codex: "Codex",
	grok: "Grok",
	gemini: "Gemini",
	cursor: "Cursor",
	opencode: "OpenCode",
	opencode2: "OpenCode 2",
	kiro: "Kiro",
	pi: "Pi",
};

export const providerLabel = (providerId: ProviderId): string =>
	PROVIDER_LABELS[providerId] ?? providerId;
