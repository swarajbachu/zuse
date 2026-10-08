import type { RegistryAgent } from "./catalog.ts";

/** Adapters and local harnesses absent from the registry. Upstream wins on ID collision. */
export const COMMUNITY_ACP_AGENTS: readonly RegistryAgent[] = [
	{
		id: "omp-acp",
		name: "Oh My Pi (OMP)",
		description:
			"ACP adapter for Oh My Pi. Requires Node.js 20+ and the omp CLI on this host; uses your existing OMP authentication.",
		version: "0.1.2",
		repository: "https://github.com/jiwangyihao/omp-acp",
		distribution: { npx: { package: "omp-acp@0.1.2" } },
	},
	{
		id: "hermes",
		name: "Hermes",
		description:
			"Uses Hermes installed on this host. Enable its ACP extra and configure a provider with hermes model before connecting.",
		version: "host",
		repository:
			"https://hermes-agent.nousresearch.com/docs/user-guide/features/acp/",
		distribution: {
			local: {
				command: "hermes",
				args: ["acp"],
				env: { HERMES_ACP_SKIP_CONFIGURED_MCP: "1" },
			},
		},
	},
	{
		id: "openclaw",
		name: "OpenClaw",
		description:
			"Uses OpenClaw installed on this host and a running, configured Gateway. Tools and workspace run on the Gateway; configure MCP there.",
		version: "host",
		repository: "https://docs.openclaw.ai/cli/acp",
		distribution: {
			local: {
				command: "openclaw",
				args: ["acp"],
				mcpEnabled: false,
			},
		},
	},
];
