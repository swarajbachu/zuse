import type {
	PermissionDecision,
	PermissionKind,
	PermissionMode,
	RuntimeMode,
} from "@zuse/contracts";

import {
	callLinearTool,
	ensureLinearToolPermission,
	isLinearToolName,
	LINEAR_MCP_SERVER_NAME,
	type LinearToolDeps,
} from "../linear-tools.ts";
import {
	type LocalMcpBridge,
	startLocalMcpBridge,
} from "./local-mcp-bridge.ts";

export interface LinearMcpBridgeOptions {
	readonly deps: LinearToolDeps;
	readonly command: string;
	readonly requestPermission: (
		kind: PermissionKind,
		options: { readonly forcePrompt: boolean },
	) => Promise<PermissionDecision>;
	readonly getRuntimeMode: () => RuntimeMode;
	readonly getPermissionMode: () => PermissionMode;
}

export type LinearMcpBridge = LocalMcpBridge;

export const startLinearMcpBridge = (
	options: LinearMcpBridgeOptions,
): Promise<LinearMcpBridge> =>
	startLocalMcpBridge({
		serverName: LINEAR_MCP_SERVER_NAME,
		command: options.command,
		environmentPrefix: "ZUSE_LINEAR_MCP",
		bundledChildUrl: new URL("./linear-mcp-child.cjs", import.meta.url),
		sourceChildUrl: new URL("./linear-mcp-child.ts", import.meta.url),
		logLabel: "zuse-linear-mcp",
		missingChildMessage: (paths) =>
			`[zuse-linear-mcp] child script missing — looked for ${paths.join(", ")}.`,
		handleTool: async (name, args) => {
			if (!isLinearToolName(name)) throw new Error(`Unknown tool: ${name}`);
			await ensureLinearToolPermission(name, args, options);
			return callLinearTool(options.deps, name, args);
		},
		errorResult: (message) => ({
			content: [{ type: "text" as const, text: message }],
			isError: true as const,
		}),
	});
