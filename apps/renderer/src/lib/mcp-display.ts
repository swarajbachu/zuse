import type { McpServerDescriptor, ProviderId } from "@zuse/contracts";

export const MCP_PROVIDER_LABEL: Record<ProviderId, string> = {
	claude: "Claude",
	codex: "Codex",
	grok: "Grok",
	gemini: "Gemini",
	cursor: "Cursor",
	opencode: "OpenCode",
};

export const MCP_DISPLAY_GROUPS = [
	{
		label: "Built-in",
		matches: (server: McpServerDescriptor) => server.source === "builtin",
	},
	{
		label: "Claude",
		matches: (server: McpServerDescriptor) =>
			server.source.startsWith("claude-"),
	},
	{
		label: "Codex",
		matches: (server: McpServerDescriptor) => server.source === "codex",
	},
	{
		label: "Provider apps",
		matches: (server: McpServerDescriptor) => server.kind === "app-group",
	},
] as const;

export const mcpTopLevelServers = (
	servers: ReadonlyArray<McpServerDescriptor>,
): ReadonlyArray<McpServerDescriptor> =>
	servers.filter((server) => server.parentKey === null);

export const mcpServersForProvider = (
	servers: ReadonlyArray<McpServerDescriptor>,
	provider: ProviderId,
): ReadonlyArray<McpServerDescriptor> =>
	servers.filter((server) => server.availableProviders.includes(provider));

export const mcpChildrenForParent = (
	servers: ReadonlyArray<McpServerDescriptor>,
	parentKey: string,
	expanded: boolean,
): ReadonlyArray<McpServerDescriptor> =>
	expanded ? servers.filter((server) => server.parentKey === parentKey) : [];

export const mcpProviderAvailabilityLabel = (
	server: McpServerDescriptor,
): string =>
	server.availableProviders
		.map((provider) => MCP_PROVIDER_LABEL[provider])
		.join(", ");
