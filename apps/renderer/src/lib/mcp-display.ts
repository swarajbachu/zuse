import "@zuse/i18n/english/shell";
import type { McpServerDescriptor, ProviderId } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";

export const MCP_PROVIDER_LABEL: Record<ProviderId, string> = {
	claude: "Claude",
	codex: "Codex",
	grok: "Grok",
	gemini: "Gemini",
	kiro: "Kiro",
	cursor: "Cursor",
	opencode: "OpenCode",
};

export const MCP_DISPLAY_GROUPS = [
	{
		get label() {
			return uiMessage("shell:mcp_display_built_in");
		},
		matches: (server: McpServerDescriptor) => server.source === "builtin",
	},
	{
		get label() {
			return uiMessage("shell:mcp_display_claude");
		},
		matches: (server: McpServerDescriptor) =>
			server.source.startsWith("claude-"),
	},
	{
		get label() {
			return uiMessage("shell:mcp_display_codex");
		},
		matches: (server: McpServerDescriptor) => server.source === "codex",
	},
	{
		get label() {
			return uiMessage("shell:mcp_display_provider_apps");
		},
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
