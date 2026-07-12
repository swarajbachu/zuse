import type {
	PermissionDecision,
	PermissionKind,
	PermissionMode,
	RuntimeMode,
} from "@zuse/contracts";

import {
	type BrowserMcpBridge,
	startBrowserMcpBridge,
} from "../drivers/acp/browser-mcp-bridge.ts";
import {
	type OrchestrationMcpBridge,
	startOrchestrationMcpBridge,
} from "../drivers/acp/orchestration-mcp-bridge.ts";
import type { BrowserSend } from "../drivers/browser-tools.ts";
import type { OrchestrationSessionTools } from "../drivers/orchestration-tools.ts";

type RequestPermission = (
	kind: PermissionKind,
	options: { readonly forcePrompt: boolean },
) => Promise<PermissionDecision>;

export interface StdioMcpFallbackOptions {
	readonly browserSend: BrowserSend;
	readonly command: string;
	readonly requestPermission: RequestPermission;
	readonly getRuntimeMode: () => RuntimeMode;
	readonly getPermissionMode: () => PermissionMode;
	readonly orchestrationTools: OrchestrationSessionTools | null;
}

export interface StdioMcpFallback {
	readonly ensure: () => Promise<
		ReadonlyArray<BrowserMcpBridge["serverConfig"]>
	>;
	readonly projectConfigToml: () => ReadonlyArray<string>;
	readonly close: () => Promise<void>;
}

export const makeStdioMcpFallback = (
	options: StdioMcpFallbackOptions,
): StdioMcpFallback => {
	let browser: BrowserMcpBridge | null = null;
	let orchestration: OrchestrationMcpBridge | null = null;

	const ensure = async () => {
		browser ??= await startBrowserMcpBridge({
			send: options.browserSend,
			command: options.command,
			requestPermission: options.requestPermission,
			getRuntimeMode: options.getRuntimeMode,
			getPermissionMode: options.getPermissionMode,
		});
		if (options.orchestrationTools !== null && orchestration === null) {
			orchestration = await startOrchestrationMcpBridge({
				deps: options.orchestrationTools.deps,
				command: options.command,
				requestPermission: options.requestPermission,
				getRuntimeMode: options.getRuntimeMode,
				getPermissionMode: options.getPermissionMode,
			});
		}
		return [
			browser.serverConfig,
			...(orchestration === null ? [] : [orchestration.serverConfig]),
		];
	};

	return {
		ensure,
		projectConfigToml: () => [
			...(browser === null ? [] : [browser.projectConfigToml]),
			...(orchestration === null ? [] : [orchestration.projectConfigToml]),
		],
		close: async () => {
			await Promise.all([
				...(browser === null ? [] : [browser.close()]),
				...(orchestration === null ? [] : [orchestration.close()]),
			]);
			browser = null;
			orchestration = null;
		},
	};
};
