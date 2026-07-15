import type {
	AgentSessionId,
	AgentSessionStartError,
	PermissionDecision,
	PermissionKind,
	PermissionMode,
	ProviderId,
	RuntimeMode,
} from "@zuse/contracts";
import { AgentSessionStartError as StartError } from "@zuse/contracts";
import { Effect } from "effect";

import type { BrowserSend } from "../drivers/browser-tools.ts";
import type { OrchestrationSessionTools } from "../drivers/orchestration-tools.ts";
import {
	issueMcpGatewaySession,
	type McpGatewaySession,
} from "../mcp-gateway/index.ts";

export interface ProviderMcpSessionOptions {
	readonly providerId: ProviderId;
	readonly sessionId: AgentSessionId;
	readonly browserSend: BrowserSend;
	readonly requestPermission: (
		kind: PermissionKind,
		options: { readonly forcePrompt: boolean },
	) => Promise<PermissionDecision>;
	readonly getRuntimeMode: () => RuntimeMode;
	readonly getPermissionMode: () => PermissionMode;
	readonly orchestrationTools: OrchestrationSessionTools | null;
}

export const issueProviderMcpSession = Effect.fn("ProviderMcpSession.issue")(
	function* (
		options: ProviderMcpSessionOptions,
	): Effect.fn.Return<McpGatewaySession, AgentSessionStartError> {
		return yield* Effect.tryPromise({
			try: () =>
				issueMcpGatewaySession({
					sessionId: options.sessionId,
					scopes: {
						browser: true,
						orchestration: options.orchestrationTools !== null,
						linear: options.orchestrationTools?.linearTools !== undefined,
					},
					ctx: {
						browser: {
							send: options.browserSend,
							requestPermission: options.requestPermission,
							getRuntimeMode: options.getRuntimeMode,
							getPermissionMode: options.getPermissionMode,
						},
						...(options.orchestrationTools === null
							? {}
							: {
									orchestration: {
										deps: options.orchestrationTools.deps,
										requestPermission: options.requestPermission,
										getRuntimeMode: options.getRuntimeMode,
										getPermissionMode: options.getPermissionMode,
									},
								}),
						...(options.orchestrationTools?.linearTools === undefined
							? {}
							: {
									linear: {
										deps: options.orchestrationTools.linearTools.deps,
										requestPermission: options.requestPermission,
										getRuntimeMode: options.getRuntimeMode,
										getPermissionMode: options.getPermissionMode,
									},
								}),
					},
				}),
			catch: (cause) =>
				new StartError({
					providerId: options.providerId,
					reason: `Could not start MCP gateway: ${
						cause instanceof Error ? cause.message : String(cause)
					}`,
				}),
		});
	},
);
