import type { ProviderId } from "@zuse/contracts";

export const PROVIDER_LABEL: Readonly<Record<ProviderId, string>> = {
	claude: "Claude Code",
	codex: "Codex",
	grok: "Grok",
	cursor: "Cursor",
	gemini: "Gemini",
	opencode: "OpenCode",
	opencode2: "OpenCode 2",
	kiro: "Kiro",
	pi: "Pi",
};
