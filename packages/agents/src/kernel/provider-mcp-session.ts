import type {
	AgentSessionId,
	AgentSessionStartError,
	PermissionDecision,
	PermissionKind,
	PermissionMode,
	ProviderId,
	RuntimeMode,
	SessionToolPolicy,
} from "@zuse/contracts";
import { AgentSessionStartError as StartError } from "@zuse/contracts";
import { Effect, Option } from "effect";
import type { BrowserSend } from "../drivers/browser-tools.ts";
import { getDefaultDeviceCommandClient } from "../drivers/device-command-tools.ts";
import { HtmlTools } from "../drivers/html-tools.ts";
import type { OrchestrationSessionTools } from "../drivers/orchestration-tools.ts";
import { getDefaultPluginClient } from "../drivers/plugin-tools.ts";
import { SimulatorTools } from "../drivers/simulator-tools.ts";
import {
	type AppMcpInteractionOptions,
	type AppToolset,
	issueMcpGatewaySession,
	type McpGatewaySession,
} from "../mcp-gateway/index.ts";

import type { ProviderStartup } from "./provider-startup.ts";

/**
 * Session-bound tools a caller gives one provider session: orchestration
 * when autonomy is on, plus any feature toolsets (a review guide run, say).
 * Drivers pass this through untouched; the gateway serves it.
 */
export interface SessionTools {
	readonly orchestration: OrchestrationSessionTools | null;
	readonly toolsets: ReadonlyArray<AppToolset>;
}

export const orchestrationSessionTools = (
	orchestration: OrchestrationSessionTools | null,
): SessionTools | null =>
	orchestration === null ? null : { orchestration, toolsets: [] };

export interface ProviderMcpSessionOptions {
	readonly providerId: ProviderId;
	readonly sessionId: AgentSessionId;
	readonly cwd: string;
	readonly browserSend: BrowserSend;
	readonly requestPermission: (
		kind: PermissionKind,
		options: { readonly forcePrompt: boolean },
	) => Promise<PermissionDecision>;
	readonly getRuntimeMode: () => RuntimeMode;
	readonly getPermissionMode: () => PermissionMode;
	readonly sessionTools: SessionTools | null;
	readonly interaction?: AppMcpInteractionOptions;
	/** `read-only` serves only the session's own toolsets, nothing that acts. */
	readonly toolPolicy?: SessionToolPolicy;
}

export const issueProviderMcpSession = Effect.fn("ProviderMcpSession.issue")(
	function* (
		startup: ProviderStartup,
		options: ProviderMcpSessionOptions,
	): Effect.fn.Return<McpGatewaySession, AgentSessionStartError> {
		const simulators = yield* Effect.serviceOption(SimulatorTools);
		const html = yield* Effect.serviceOption(HtmlTools);
		const plugins = yield* Effect.promise(getDefaultPluginClient);
		const orchestration = options.sessionTools?.orchestration ?? null;
		const toolsets = options.sessionTools?.toolsets ?? [];
		const readOnly = options.toolPolicy === "read-only";
		return yield* Effect.tryPromise({
			try: () =>
				startup.acquire(
					() =>
						issueMcpGatewaySession(
							readOnly
								? {
										sessionId: options.sessionId,
										scopes: { browser: false, orchestration: false },
										ctx: { toolsets },
									}
								: {
										sessionId: options.sessionId,
										scopes: {
											plugins: plugins !== undefined,
											browser: true,
											orchestration: orchestration !== null,
											images: true,
											html: Option.isSome(html),
											simulators: Option.isSome(simulators),
											deviceCommands:
												getDefaultDeviceCommandClient() !== undefined,
											interaction: options.interaction !== undefined,
										},
										ctx: {
											toolsets,
											plugins: plugins
												? {
														client: plugins,
														requestPermission: options.requestPermission,
														getRuntimeMode: options.getRuntimeMode,
														getPermissionMode: options.getPermissionMode,
													}
												: undefined,
											images: { cwd: options.cwd },
											...(Option.isSome(simulators)
												? {
														simulators: {
															client: simulators.value,
															requestPermission: options.requestPermission,
															getRuntimeMode: options.getRuntimeMode,
															getPermissionMode: options.getPermissionMode,
														},
													}
												: {}),
											...(Option.isSome(html)
												? { html: { client: html.value, cwd: options.cwd } }
												: {}),
											deviceCommands: getDefaultDeviceCommandClient(),
											getPermissionMode: options.getPermissionMode,
											browser: {
												send: options.browserSend,
												requestPermission: options.requestPermission,
												getRuntimeMode: options.getRuntimeMode,
												getPermissionMode: options.getPermissionMode,
											},
											...(orchestration === null
												? {}
												: {
														orchestration: {
															deps: orchestration.deps,
															requestPermission: options.requestPermission,
															getRuntimeMode: options.getRuntimeMode,
															getPermissionMode: options.getPermissionMode,
														},
													}),
											...(options.interaction === undefined
												? {}
												: { interaction: options.interaction }),
										},
									},
							startup.signal,
						),
					(session) => session.close(),
				),
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
