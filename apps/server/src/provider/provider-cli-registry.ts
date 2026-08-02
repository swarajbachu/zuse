import type { ProviderId } from "@zuse/contracts";

type CliProviderId = Exclude<ProviderId, "cursor">;

export interface ProviderCliDescriptor {
	readonly providerId: CliProviderId;
	readonly displayName: string;
	readonly cliBinary: string;
}

export const PROVIDER_CLI_REGISTRY = {
	claude: {
		providerId: "claude",
		displayName: "Claude Code",
		cliBinary: "claude",
	},
	codex: {
		providerId: "codex",
		displayName: "Codex",
		cliBinary: "codex",
	},
	grok: {
		providerId: "grok",
		displayName: "Grok",
		cliBinary: "grok",
	},
	gemini: {
		providerId: "gemini",
		displayName: "Gemini",
		cliBinary: "gemini",
	},
	opencode: {
		providerId: "opencode",
		displayName: "OpenCode",
		cliBinary: "opencode",
	},
} as const satisfies Record<CliProviderId, ProviderCliDescriptor>;

export const SUPPORTED_PROVIDER_CLIS: ReadonlyArray<ProviderCliDescriptor> =
	Object.values(PROVIDER_CLI_REGISTRY);
