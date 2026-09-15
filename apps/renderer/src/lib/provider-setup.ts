import type { ProviderId } from "@zuse/contracts";

export const INSTALL_HINT: Partial<Record<ProviderId, string>> = {
	claude: "npm i -g @anthropic-ai/claude-code",
	codex: "npm i -g @openai/codex",
	grok: "curl -fsSL https://x.ai/cli/install.sh | bash",
	gemini: "npm i -g @google/gemini-cli",
	opencode: "curl -fsSL https://opencode.ai/install | bash",
	opencode2: "curl -fsSL https://opencode.ai/v2/install | bash",
	kiro: "Install from https://kiro.dev",
	pi: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
};
