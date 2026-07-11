import type {
	PermissionDecision,
	PermissionKind,
	PermissionMode,
	RuntimeMode,
} from "@zuse/contracts";

import {
	BROWSER_MCP_SERVER_NAME,
	type BrowserMcpToolResult,
	handleBrowserTool,
} from "../browser-mcp-tools.ts";
import type { BrowserSend } from "../browser-tools.ts";
import {
	type LocalMcpBridge,
	startLocalMcpBridge,
} from "./local-mcp-bridge.ts";

export { browserMcpPromptHint } from "../browser-mcp-tools.ts";

const text = (value: string, isError = false): BrowserMcpToolResult => ({
	content: [{ type: "text", text: value }],
	...(isError ? { isError: true } : {}),
});

export interface BrowserMcpBridgeOptions {
	readonly send: BrowserSend;
	readonly command: string;
	readonly requestPermission: (
		kind: PermissionKind,
		options: { readonly forcePrompt: boolean },
	) => Promise<PermissionDecision>;
	readonly getRuntimeMode: () => RuntimeMode;
	readonly getPermissionMode: () => PermissionMode;
}

export type BrowserMcpBridge = LocalMcpBridge;

export const startBrowserMcpBridge = (
	options: BrowserMcpBridgeOptions,
): Promise<BrowserMcpBridge> =>
	startLocalMcpBridge({
		serverName: BROWSER_MCP_SERVER_NAME,
		command: options.command,
		environmentPrefix: "ZUSE_BROWSER_MCP",
		bundledChildUrl: new URL("./browser-mcp-child.cjs", import.meta.url),
		sourceChildUrl: new URL("./browser-mcp-child.ts", import.meta.url),
		logLabel: "grok.browser-mcp",
		missingChildMessage: (paths) =>
			`[grok.browser-mcp] child script missing — looked for ${paths.join(", ")}. Browser tools will be unavailable to this ACP session (did the desktop build emit browser-mcp-child.cjs?).`,
		handleTool: (name, args) => handleBrowserTool(name, args, options),
		errorResult: (message) => text(message, true),
	});
