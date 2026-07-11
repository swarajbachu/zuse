import type {
	PermissionDecision,
	PermissionKind,
	PermissionMode,
	RuntimeMode,
} from "@zuse/contracts";

import {
	callOrchestrationTool,
	ensureOrchestrationPermission,
	isOrchestrationToolName,
	ORCHESTRATION_MCP_SERVER_NAME,
	ORCHESTRATION_MCP_TOOLS,
	type OrchestrationMcpToolResult,
	type OrchestrationToolDeps,
} from "../orchestration-tools.ts";
import {
	type LocalMcpBridge,
	startLocalMcpBridge,
} from "./local-mcp-bridge.ts";

const text = (value: string, isError = false): OrchestrationMcpToolResult => ({
	content: [{ type: "text", text: value }],
	...(isError ? { isError: true } : {}),
});

export interface OrchestrationMcpBridgeOptions {
	readonly deps: OrchestrationToolDeps;
	readonly command: string;
	readonly requestPermission: (
		kind: PermissionKind,
		options: { readonly forcePrompt: boolean },
	) => Promise<PermissionDecision>;
	readonly getRuntimeMode: () => RuntimeMode;
	readonly getPermissionMode: () => PermissionMode;
}

export type OrchestrationMcpBridge = LocalMcpBridge;

export const startOrchestrationMcpBridge = (
	options: OrchestrationMcpBridgeOptions,
): Promise<OrchestrationMcpBridge> =>
	startLocalMcpBridge({
		serverName: ORCHESTRATION_MCP_SERVER_NAME,
		command: options.command,
		environmentPrefix: "ZUSE_ORCHESTRATION_MCP",
		bundledChildUrl: new URL("./orchestration-mcp-child.cjs", import.meta.url),
		sourceChildUrl: new URL("./orchestration-mcp-child.ts", import.meta.url),
		logLabel: "zuse-orchestration-mcp",
		missingChildMessage: (paths) =>
			`[zuse-orchestration-mcp] child script missing — looked for ${paths.join(", ")}.`,
		handleTool: async (name, args) => {
			if (!isOrchestrationToolName(name)) {
				throw new Error(`Unknown tool: ${name}`);
			}
			await ensureOrchestrationPermission(name, args, options);
			return callOrchestrationTool(options.deps, name, args);
		},
		errorResult: (message) => text(message, true),
	});

export const orchestrationToolNames = (): ReadonlyArray<string> =>
	ORCHESTRATION_MCP_TOOLS.map((toolDef) => toolDef.name);
