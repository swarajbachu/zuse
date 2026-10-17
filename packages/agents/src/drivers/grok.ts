import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { decodeJsonRpcLine } from "@zuse/acp/protocol";
import { AcpRpcClient } from "@zuse/acp/rpc-client";
import {
	type AgentEvent,
	type AgentItemId,
	type AgentSessionId,
	AgentSessionStartError,
	type AttachmentRef,
	type PermissionMode,
	type PlanApprovalOutcome,
	type StartSessionInput,
	ThreadGoal,
	type ThreadGoalSetInput,
	type UserQuestionAnswer,
} from "@zuse/contracts";
import { spawn } from "@zuse/utils/spawn-command";
import { type Cause, Effect, Queue, Stream } from "effect";
import { makeAcpPermissionContext } from "../kernel/acp-permission-context.ts";
import { createAcpSession } from "../kernel/acp-session.ts";
import { AttachmentService } from "../kernel/attachment-service.ts";
import type {
	GoalCapableSessionHandle,
	ProviderDriverEvent,
	QuestionCallbackReleased,
} from "../kernel/driver.ts";
import { issueProviderMcpSession } from "../kernel/provider-mcp-session.ts";
import {
	stopProviderProcess,
	watchProviderProcess,
} from "../kernel/provider-process.ts";
import { withProviderStartup } from "../kernel/provider-startup.ts";
import { makeStdioMcpFallback } from "../kernel/stdio-mcp-fallback.ts";
import { makeBoundedQuestionCallbackRegistry } from "../kernel/user-question-answer.ts";
import { prefixFirstPromptWithWorkspaceInstructions } from "../kernel/workspace-instructions.ts";
import { handleFsRequest } from "./acp/fs.ts";
import {
	handleAcpNativePermissionRequest,
	isAcpNativePermissionMethod,
} from "./acp/native-permission.ts";
import { replyToAcpRequest } from "./acp/request-reply.ts";
import { handleTerminalRequest } from "./acp/terminal.ts";
import { createAcpTranslator } from "./acp/translate.ts";
import { makeAcpUserQuestionRegistry } from "./acp/user-question.ts";
import { buildAcpPromptContent } from "./acp-image-content.ts";
import type { BrowserSend } from "./browser-tools.ts";
import type { GetRuntimeMode, RequestPermission } from "./claude.ts";
import {
	finishCompactEvent,
	isCompactCommand,
	startCompactEvent,
	startCompactSnapshot,
} from "./compact.ts";
import {
	classifyGrokRpcError,
	createGrokEventCursor,
	createGrokLifecycle,
	decodeGrokInitializeResult,
	decodeGrokNotification,
	decodeGrokWireMethod,
	decodePlanApprovalRequest,
	GROK_MINIMUM_VERSION,
	GROK_UPDATE_COMMAND,
	grokAgentArgs,
	grokInitializeParams,
	grokSessionFailureAction,
	isSupportedGrokVersion,
	mapGrokMode,
	selectGrokHandshakeAuth,
	translateGrokExtensionMethod,
	translateGrokExtensionUpdate,
} from "./grok/protocol.ts";
import type { OrchestrationSessionTools } from "./orchestration-tools.ts";
import { pluginCliEnv } from "./plugin-tools.ts";

const GROK_NATIVE_MCP_DISABLED_ENV = {
	GROK_CURSOR_MCPS_ENABLED: "0",
	GROK_CLAUDE_MCPS_ENABLED: "0",
	GROK_CODEX_MCPS_ENABLED: "0",
	GROK_MANAGED_MCPS_ENABLED: "0",
} as const;

class GrokProtocolError extends Error {
	constructor(
		readonly kind: ReturnType<typeof classifyGrokRpcError>,
		message: string,
		readonly sessionMissing = false,
	) {
		super(message);
	}
}

/**
 * Live-only handle for one Grok conversation. Mirrors Codex/Claude handle
 * shape so `ProviderService` routes RPCs without caring which provider
 * backs the session.
 *
 * Grok has no embeddable JS SDK; instead we drive it via ACP — the agent
 * runs as `grok agent stdio`, a JSON-RPC server on stdin/stdout. One
 * persistent child per session (Claude-style), not one spawn per turn
 * (Codex-style). The conversation is identified by an ACP-minted
 * `sessionId` returned from `session/new`; we surface that as a
 * `SessionCursor { strategy: "grok-session-id" }` so it persists.
 */
export interface GrokSessionHandle extends GoalCapableSessionHandle {
	readonly events: Stream.Stream<ProviderDriverEvent>;
	readonly send: (
		text: string,
		attachments?: ReadonlyArray<AttachmentRef>,
	) => Effect.Effect<void>;
	readonly interrupt: () => Effect.Effect<void>;
	readonly close: () => Effect.Effect<void>;
	/** Request the native mode; UI state changes only on CurrentModeUpdate. */
	readonly setPermissionMode: (mode: PermissionMode) => Effect.Effect<void>;
	/** Resolve a blocking ACP user-question request by its provider item id. */
	readonly answerQuestion: (
		itemId: AgentItemId,
		answers: ReadonlyArray<UserQuestionAnswer>,
	) => Effect.Effect<void, Error>;
	readonly respondToPlan: (
		toolCallId: AgentItemId,
		outcome: PlanApprovalOutcome,
		feedback?: string,
	) => Effect.Effect<void, Error>;
	/**
	 * Goal control is sent through native slash commands; state is sourced only
	 * from typed `goal_updated` notifications.
	 */
	readonly getGoal: () => Effect.Effect<ThreadGoal | null>;
	readonly setGoal: (
		goal: ThreadGoalSetInput,
		options?: { readonly execute?: boolean },
	) => Effect.Effect<ThreadGoal>;
	readonly clearGoal: () => Effect.Effect<void>;
}

const GROK_RPC_TRACE = process.env.MEMOIZE_DEBUG_GROK === "1";
const GROK_DIAG =
	process.env.MEMOIZE_DEBUG_GROK === "1" ||
	process.env.MEMOIZE_DEBUG_GROK_DIAG === "1";

const grokDiag = (label: string, data?: unknown): void => {
	if (!GROK_DIAG && !GROK_RPC_TRACE) return;
	const prefix = `[grok.diag] ${label}`;
	if (data === undefined) {
		process.stderr.write(`${prefix}\n`);
	} else {
		try {
			const s = typeof data === "string" ? data : JSON.stringify(data, null, 2);
			process.stderr.write(`${prefix}: ${s}\n`);
		} catch {
			process.stderr.write(`${prefix}: (unserialisable)\n`);
		}
	}
};

export const isGrokNativePermissionMethod = (method: string): boolean =>
	isAcpNativePermissionMethod(method);

export const handleGrokNativePermissionRequest =
	handleAcpNativePermissionRequest;

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;

/**
 * Spin up a Grok conversation backed by a persistent ACP child process.
 * The handshake (`initialize` → `authenticate` → `session/new`) runs once
 * synchronously inside `start()`; auth or transport failures surface there
 * so the orchestrator can fail the session-create RPC cleanly.
 *
 * `apiKey` is forwarded as `GROK_CODE_XAI_API_KEY` on the child env. When
 * null the child reads cached credentials from `~/.grok/` (browser-OAuth
 * `grok login` flow). `xai.api_key` auth method is preferred when a key
 * is set; otherwise `cached_token`.
 */
export const startGrokSession = (
	input: StartSessionInput,
	cwd: string,
	apiKey: string | null,
	grokPath: string,
	sessionId: AgentSessionId,
	requestPermission: RequestPermission,
	getRuntimeMode: GetRuntimeMode,
	browserSend: BrowserSend,
	mcpProxyCommand: string,
	orchestrationTools: OrchestrationSessionTools | null = null,
	resumeCursor: string | null = null,
	providerEventCursor: string | null = null,
): Effect.Effect<
	GrokSessionHandle,
	AgentSessionStartError,
	AttachmentService
> =>
	withProviderStartup(function* (startup) {
		const attachments = yield* AttachmentService;
		const events = yield* Queue.make<ProviderDriverEvent, Cause.Done>();

		let currentMode: PermissionMode = input.permissionMode ?? "default";

		let gatewayQuestionCounter = 0;
		const gatewayQuestionResponses =
			makeBoundedQuestionCallbackRegistry<
				(answers: ReadonlyArray<UserQuestionAnswer> | null) => void
			>();
		const releaseGatewayQuestions = (
			reason: QuestionCallbackReleased["reason"],
		): void => {
			for (const [itemId, resolve] of gatewayQuestionResponses.drain()) {
				resolve(null);
				Queue.offerUnsafe(events, {
					_tag: "QuestionCallbackReleased",
					itemId: itemId as AgentItemId,
					reason,
				});
			}
		};
		startup.add(() => releaseGatewayQuestions("closed"));

		const mcpGatewaySession = yield* issueProviderMcpSession(startup, {
			providerId: "grok",
			sessionId,
			cwd,
			browserSend,
			requestPermission: (kind, options) =>
				requestPermission(sessionId, kind, options),
			getRuntimeMode,
			getPermissionMode: () => currentMode,
			orchestrationTools,
			interaction: {
				askUserQuestion: (questions) => {
					const itemId =
						`grok_mcp_question_${Date.now()}_${++gatewayQuestionCounter}` as AgentItemId;
					return new Promise((resolve) => {
						if (
							gatewayQuestionResponses.register(itemId, resolve) !== "accepted"
						) {
							resolve(null);
							return;
						}
						Queue.offerUnsafe(events, {
							_tag: "UserQuestion",
							itemId,
							questions,
						});
					});
				},
			},
		});
		const executionEnv = {
			...input.executionEnv,
			...pluginCliEnv(mcpGatewaySession.endpoint, mcpGatewaySession.token),
		};

		const acpHandlerContext = makeAcpPermissionContext({
			executionEnv,
			cwd,
			sessionId,
			projectId: input.folderId,
			requestPermission: (kind, options) =>
				requestPermission(sessionId, kind, options),
			getRuntimeMode,
			getPermissionMode: () => currentMode,
		});
		const grokMcpServers = [mcpGatewaySession.serverConfig];
		const stdioMcpFallback = makeStdioMcpFallback({
			command: mcpProxyCommand,
			endpoint: mcpGatewaySession.endpoint,
			token: mcpGatewaySession.token,
		});
		startup.add(() => stdioMcpFallback.close());
		let acpSessionId: string | null = null;
		const configuredHome = process.env.GROK_HOME?.trim();
		const providerHome =
			configuredHome === undefined || configuredHome.length === 0
				? path.join(homedir(), ".grok")
				: path.resolve(cwd, configuredHome);
		const currentPlanFilePath = (): string | undefined => {
			if (acpSessionId === null) return undefined;
			const encodedCwd = encodeURIComponent(cwd).replace(
				/[!'()*]/g,
				(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
			);
			return path.join(
				providerHome,
				"sessions",
				encodedCwd,
				acpSessionId,
				"plan.md",
			);
		};
		let closed = false;

		let currentGoal: ThreadGoal | null = null;
		let currentCompactionItemId: AgentItemId | null = null;
		const pendingPlanResponses = new Map<
			string,
			{ readonly rpcId: string | number }
		>();
		const eventCursor = createGrokEventCursor(providerEventCursor);
		const lifecycle = createGrokLifecycle();

		let dead = false;
		let terminalFailure = false;

		let inflight: Promise<void> = Promise.resolve();
		let workspaceInstructionsPending = input.workspaceInstructions;

		let stderrTail = "";

		let authMethodUsed: string | null = null;

		Queue.offerUnsafe(events, {
			_tag: "Started",
			sessionId,
			providerId: "grok",
			mode: "sdk",
		});

		const translator = createAcpTranslator("grok", {
			onCheckpoint: (checkpointEvents) => {
				for (const event of checkpointEvents) Queue.offerUnsafe(events, event);
			},
		});
		const translatorsBySession = new Map<string, typeof translator>();
		const subagentParentBySession = new Map<string, AgentItemId>();
		const translatorFor = (providerSessionId: string) => {
			if (providerSessionId === acpSessionId) return translator;
			const existing = translatorsBySession.get(providerSessionId);
			if (existing !== undefined) return existing;
			const created = createAcpTranslator("grok", {
				onCheckpoint: (checkpointEvents) => {
					for (const event of checkpointEvents) {
						Queue.offerUnsafe(
							events,
							routeSubagentEvent(event, providerSessionId),
						);
					}
				},
			});
			translatorsBySession.set(providerSessionId, created);
			return created;
		};
		const routeSubagentEvent = (
			event: AgentEvent,
			providerSessionId: string,
		): AgentEvent => {
			const parentItemId = subagentParentBySession.get(providerSessionId);
			if (parentItemId === undefined) return event;
			switch (event._tag) {
				case "AssistantMessage":
				case "Thinking":
				case "ToolUse":
				case "ToolResult":
					return { ...event, parentItemId };
				default:
					return event;
			}
		};

		let child: ChildProcessWithoutNullStreams;
		let rl: readline.Interface;
		let connectionGeneration = 0;

		const connectChild = async (
			cursor: string | null,
		): Promise<{ readonly sessionId: string; readonly resumed: boolean }> => {
			lifecycle.transition(
				lifecycle.current() === "start" ? "authentication" : "reconnecting",
			);
			startup.signal.throwIfAborted();
			const generation = ++connectionGeneration;
			const nextChild = spawn(grokPath, grokAgentArgs(getRuntimeMode()), {
				cwd,
				env: {
					...process.env,
					...executionEnv,

					...GROK_NATIVE_MCP_DISABLED_ENV,
					...(apiKey !== null ? { GROK_CODE_XAI_API_KEY: apiKey } : {}),
				},
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
			});
			watchProviderProcess(nextChild);
			startup.add(() => stopProviderProcess(nextChild, { processGroup: true }));
			stderrTail = "";
			nextChild.stdout.setEncoding("utf-8");
			nextChild.stderr.setEncoding("utf-8");
			const nextRl = readline.createInterface({ input: nextChild.stdout });
			startup.add(() => nextRl.close());
			child = nextChild;
			rl = nextRl;
			attachListeners(nextChild, nextRl, generation);
			try {
				return await runHandshake(cursor);
			} catch (cause) {
				nextRl.close();
				await stopProviderProcess(nextChild, { processGroup: true });
				throw cause;
			}
		};

		const writeMessage = (msg: Record<string, unknown>): void => {
			if (!child.stdin.writable) return;
			const line = JSON.stringify(msg);
			if (GROK_RPC_TRACE) {
				process.stderr.write(
					`[grok.rpc.send] method=${typeof msg.method === "string" ? msg.method : "response"} id=${String(msg.id ?? "-")}\n`,
				);
			}
			child.stdin.write(`${line}\n`);
		};

		const rpc = new AcpRpcClient(writeMessage);
		startup.add(() => {
			closed = true;
			rpc.rejectAll(new Error("Provider startup cancelled"));
			Queue.endUnsafe(events);
		});
		const userQuestions = makeAcpUserQuestionRegistry({
			send: writeMessage,
			emit: (event) => Queue.offerUnsafe(events, event),
			release: (itemId, reason) =>
				Queue.offerUnsafe(events, {
					_tag: "QuestionCallbackReleased",
					itemId,
					reason,
				}),
		});
		startup.add(() => {
			userQuestions.discardAll();
		});
		const request = (
			method: string,
			params: unknown,
			timeoutMs: number | null = 30_000,
			onAssignedId?: (id: number) => void,
		): Promise<unknown> =>
			rpc.request(method, params, {
				timeoutMs,
				onAssignedId,
				...(timeoutMs === null
					? {}
					: {
							timeoutError: () =>
								new Error(`Grok ACP ${method} timed out after ${timeoutMs}ms`),
						}),
			});

		const notify = (method: string, params: unknown): void => {
			rpc.notify(method, params);
		};

		let currentPromptRpcId: number | null = null;
		const rejectCurrentPrompt = (reason: string): void => {
			const id = currentPromptRpcId;
			if (id === null) return;
			const cancelled = rpc.cancel(id, new Error(reason));
			if (cancelled === null) return;
			currentPromptRpcId = null;
			if (GROK_RPC_TRACE) {
				process.stderr.write(
					`[grok.rpc.cancel] force-reject id=${id} method=${cancelled.method} reason=${reason}\n`,
				);
			}
		};

		const attachListeners = (
			sourceChild: ChildProcessWithoutNullStreams,
			sourceRl: readline.Interface,
			generation: number,
		): void => {
			sourceRl.on("line", (line: string) => {
				if (generation !== connectionGeneration) return;
				if (line.trim().length === 0) return;
				if (GROK_RPC_TRACE) process.stderr.write("[grok.rpc.recv] frame\n");
				const msg = decodeJsonRpcLine(line);
				if (msg === null) {
					return;
				}

				if (typeof msg.method === "string") {
					const wireMethod = decodeGrokWireMethod(msg.method, msg.params);
					const normalizedMethod = wireMethod.method;
					const methodParams = wireMethod.params;
					if (
						normalizedMethod === "session/update" ||
						normalizedMethod === "x.ai/session_notification" ||
						normalizedMethod === "x.ai/session/update"
					) {
						try {
							const notification = decodeGrokNotification(methodParams);
							const { update, meta } = notification;
							if (!eventCursor.shouldProcess(meta.eventId)) return;
							Queue.offerUnsafe(events, {
								_tag: "ProviderNotificationMetadata",
								...meta,
							});
							const extensionEvents = translateGrokExtensionUpdate(update).map(
								(event): AgentEvent => {
									if (event._tag !== "ContextCompaction") return event;
									if (event.status === "in_progress") {
										currentCompactionItemId = event.itemId;
										return event;
									}
									const itemId = currentCompactionItemId ?? event.itemId;
									currentCompactionItemId = null;
									return { ...event, itemId };
								},
							);
							for (const event of extensionEvents) {
								if (event._tag === "ToolUse" && event.subagent !== undefined) {
									subagentParentBySession.set(
										event.subagent.childSessionId,
										event.itemId,
									);
									translatorFor(event.subagent.childSessionId);
								}
							}
							const finishedChildSessionId =
								update.sessionUpdate === "subagent_finished" &&
								typeof update.child_session_id === "string"
									? update.child_session_id
									: null;
							const finalChildEvents =
								finishedChildSessionId === null
									? []
									: translatorFor(finishedChildSessionId)
											.flush()
											.map((event) =>
												routeSubagentEvent(event, finishedChildSessionId),
											);
							const translated = [
								...finalChildEvents,
								...extensionEvents,
								...translatorFor(notification.sessionId)
									.translate(update)
									.map((event) =>
										routeSubagentEvent(event, notification.sessionId),
									),
							];
							for (const ev of translated) {
								if (ev._tag === "GoalUpdated")
									currentGoal = ThreadGoal.make(ev.goal);
								if (ev._tag === "GoalCleared") currentGoal = null;
								Queue.offerUnsafe(events, ev);
							}
							if (finishedChildSessionId !== null) {
								translatorsBySession.delete(finishedChildSessionId);
								subagentParentBySession.delete(finishedChildSessionId);
							}
							if (update.sessionUpdate === "current_mode_update") {
								const modeId = update.currentModeId;
								if (modeId === "plan" || modeId === "default") {
									currentMode = modeId;
									Queue.offerUnsafe(events, {
										_tag: "PermissionModeChanged",
										mode: modeId,
									});
								}
							}
							if (meta.eventId !== undefined) {
								if (acpSessionId !== null)
									Queue.offerUnsafe(events, {
										_tag: "SessionCursor",
										cursor: acpSessionId,
										providerEventCursor: meta.eventId,
										strategy: "grok-session-id",
									});
							}
						} catch (cause) {
							grokDiag(
								"invalid session/update",
								cause instanceof Error ? cause.message : String(cause),
							);
						}
						return;
					}
					const dedicatedEvents = translateGrokExtensionMethod(
						normalizedMethod,
						methodParams,
					);
					if (dedicatedEvents.length > 0) {
						for (const event of dedicatedEvents)
							Queue.offerUnsafe(events, event);
						return;
					}

					if (
						normalizedMethod.startsWith("item/") ||
						normalizedMethod.startsWith("thread/")
					) {
						if (GROK_RPC_TRACE) {
							process.stderr.write(`[grok.rpc] ${normalizedMethod}\n`);
						}
						if (methodParams !== undefined) {
							const update = {
								...(methodParams !== null && typeof methodParams === "object"
									? (methodParams as Record<string, unknown>)
									: { params: methodParams }),
								method: normalizedMethod,
							};
							const translated = translator.translate(update);
							for (const ev of translated) {
								Queue.offerUnsafe(events, ev);
							}
						}
						return;
					}

					if (msg.id !== undefined && msg.id !== null) {
						const extensionMethod = normalizedMethod;
						if (extensionMethod === "x.ai/exit_plan_mode") {
							try {
								const plan = decodePlanApprovalRequest(methodParams);
								pendingPlanResponses.set(plan.toolCallId, { rpcId: msg.id });
								lifecycle.transition("waiting-for-input");
								Queue.offerUnsafe(events, {
									_tag: "ToolUse",
									itemId: plan.toolCallId as AgentItemId,
									tool: "ExitPlanMode",
									input: { plan: plan.planContent },
								});
								Queue.offerUnsafe(events, {
									_tag: "PlanApprovalRequested",
									sessionId,
									toolCallId: plan.toolCallId as AgentItemId,
									plan: plan.planContent,
								});
							} catch {
								writeMessage({
									jsonrpc: "2.0",
									id: msg.id,
									error: {
										code: -32602,
										message: "Invalid plan approval request",
									},
								});
							}
							return;
						}

						const isFs = normalizedMethod.startsWith("fs/");
						if (GROK_RPC_TRACE || isFs) {
							process.stderr.write(
								`[grok.rpc] server→client request method=${normalizedMethod} id=${msg.id}\n`,
							);
						}
						if (isFs) {
							replyToAcpRequest(
								(message) => rpc.send(message),
								msg.id,
								handleFsRequest(
									normalizedMethod,
									methodParams,
									acpHandlerContext(),
									{ planFilePath: currentPlanFilePath() },
								),
							);
							return;
						}

						if (normalizedMethod.startsWith("terminal/")) {
							replyToAcpRequest(
								(message) => rpc.send(message),
								msg.id,
								handleTerminalRequest(
									normalizedMethod,
									methodParams,
									acpHandlerContext(),
								),
							);
							return;
						}

						if (isGrokNativePermissionMethod(normalizedMethod)) {
							process.stderr.write(
								`[grok.rpc] native permission request method=${normalizedMethod} id=${msg.id}\n`,
							);
							handleGrokNativePermissionRequest(
								normalizedMethod,
								methodParams,
								acpHandlerContext(),
							)
								.then((result) => {
									if (result === null) {
										writeMessage({
											jsonrpc: "2.0",
											id: msg.id,
											error: {
												code: -32601,
												message: `Method not supported by Zuse ACP client: ${normalizedMethod}`,
											},
										});
										return;
									}
									writeMessage({ jsonrpc: "2.0", id: msg.id, result });
								})
								.catch((err) => {
									const message =
										err instanceof Error ? err.message : String(err);
									writeMessage({
										jsonrpc: "2.0",
										id: msg.id,
										error: { code: -32603, message },
									});
								});
							return;
						}

						const questionResult = userQuestions.handleRequest(
							extensionMethod,
							methodParams,
							msg.id,
						);
						if (questionResult !== "unhandled") {
							if (questionResult === "accepted") {
								lifecycle.transition("waiting-for-input");
							}
							return;
						}

						writeMessage({
							jsonrpc: "2.0",
							id: msg.id,
							error: {
								code: -32601,
								message: `Method not supported by Zuse ACP client: ${normalizedMethod}`,
							},
						});
						grokDiag("replied to unhandled server→client request", {
							method: normalizedMethod,
							id: msg.id,
						});
						return;
					}

					return;
				}

				rpc.acceptResponse(msg, {
					mapError: (error, context) => {
						const classified = classifyGrokRpcError(error);
						const rpcCode = asRecord(error)?.code;
						process.stderr.write(
							`[grok.rpc.error] method=${context.method} id=${context.id} kind=${classified} code=${typeof rpcCode === "number" ? rpcCode : "unknown"}\n`,
						);
						const errorRecord = asRecord(error);
						const errorData = asRecord(errorRecord?.data);
						return new GrokProtocolError(
							classified,
							`Grok ${context.method} failed (${classified}, code ${typeof rpcCode === "number" ? rpcCode : "unknown"}).`,
							errorRecord?.code === -32006 ||
								errorData?.code === "session_not_found" ||
								(context.method === "session/load" &&
									errorData?.code === "FS_NOT_FOUND"),
						);
					},
				});
			});

			sourceChild.stderr.on("data", (chunk: string) => {
				if (generation !== connectionGeneration) return;

				stderrTail = (stderrTail + chunk).slice(-4096);
			});

			sourceChild.on("error", (err) => {
				if (generation !== connectionGeneration) return;
				if (closed) return;
				dead = true;
				grokDiag("child process error event", { message: err.message });
			});

			sourceChild.on("close", (code, signal) => {
				sourceRl.close();
				if (generation !== connectionGeneration) return;
				dead = true;
				eventCursor.resetPending();
				const trimmedStderr = stderrTail.trim();
				const exitDetail = `Grok ACP transport closed (code ${code ?? "null"}, signal ${signal ?? "null"}).`;

				grokDiag("child process closed", {
					code,
					signal,
					stderrTailLen: trimmedStderr.length,
				});
				rpc.rejectAll(new Error(exitDetail));
				if (!closed) {
					for (const toolCallId of pendingPlanResponses.keys()) {
						Queue.offerUnsafe(events, {
							_tag: "ToolResult",
							itemId: toolCallId as AgentItemId,
							output: { outcome: "abandoned", reason: "transport_lost" },
							isError: true,
						});
					}
					for (const toolCallId of userQuestions.discardAll()) {
						Queue.offerUnsafe(events, {
							_tag: "ToolResult",
							itemId: toolCallId as AgentItemId,
							output: { outcome: "cancelled", reason: "transport_lost" },
							isError: true,
						});
					}
					pendingPlanResponses.clear();
					releaseGatewayQuestions("transport_lost");

					Queue.offerUnsafe(events, { _tag: "Status", status: "idle" });
					grokDiag(
						"child closed — keeping mailbox alive for transparent respawn on next send",
						{
							transportClosed: true,
						},
					);
					return;
				}

				Queue.endUnsafe(events);
			});
		};

		const runHandshake = async (
			cursor: string | null,
		): Promise<{ readonly sessionId: string; readonly resumed: boolean }> => {
			const init = decodeGrokInitializeResult(
				await request("initialize", grokInitializeParams(getRuntimeMode())),
			);
			if (!isSupportedGrokVersion(init.agentVersion)) {
				throw new Error(
					`Grok ${init.agentVersion} is unsupported. Version ${GROK_MINIMUM_VERSION} or newer is required. Update with: ${GROK_UPDATE_COMMAND}`,
				);
			}

			grokDiag("handshake initialize returned authMethods", init.authMethods);

			const authSelection = selectGrokHandshakeAuth(
				init.authMethods,
				apiKey !== null,
				init.externalAuthMethods,
			);
			if (authSelection.kind === "interactive") {
				throw new GrokProtocolError(
					"auth",
					"Authentication required. Sign in to Grok to continue.",
				);
			}
			if (authSelection.kind === "unavailable") {
				throw new Error(
					"Grok authentication is unavailable with the current configuration. Configure the required login method or set GROK_CODE_XAI_API_KEY.",
				);
			}
			const { methodId } = authSelection;
			authMethodUsed = methodId;
			grokDiag("choosing auth method", {
				methodId,
				hasApiKey: apiKey !== null,
			});

			await request("authenticate", {
				methodId,
				_meta: { headless: true },
			});
			grokDiag("authenticate succeeded", {
				methodId,
				authMethodUsed,
			});

			const acquisition = await createAcpSession({
				request,
				cwd,
				sessionId,
				providerLabel: "Grok",
				httpServers: init.mcp.http
					? grokMcpServers
					: await stdioMcpFallback.ensure(),
				...(init.mcp.http ? { fallbackServers: stdioMcpFallback.ensure } : {}),
				resumeCursor: cursor,
				providerEventCursor: eventCursor.value(),
				shouldReplaceMissingSession: (cause) =>
					cause instanceof GrokProtocolError && cause.sessionMissing,
			});
			grokDiag(
				acquisition.resumed
					? "session/load succeeded"
					: "session/new succeeded",
				{
					sessionId: acquisition.sessionId,
					authMethodUsed,
				},
			);
			acpSessionId = acquisition.sessionId;
			dead = false;
			await request("session/set_mode", {
				sessionId: acpSessionId,
				modeId: mapGrokMode(currentMode),
			});
			lifecycle.transition("idle");
			return acquisition;
		};

		const initialAcquisition = yield* Effect.tryPromise({
			try: () => connectChild(resumeCursor),
			catch: (cause) =>
				new AgentSessionStartError({
					providerId: "grok",
					reason: cause instanceof Error ? cause.message : String(cause),
				}),
		});
		acpSessionId = initialAcquisition.sessionId;
		Queue.offerUnsafe(events, {
			_tag: "SessionCursor",
			cursor: acpSessionId,
			strategy: "grok-session-id",
		});

		if (resumeCursor !== null && !initialAcquisition.resumed) {
			console.warn(
				`[grok] cursor ${resumeCursor} was unavailable; using replacement session ${acpSessionId}`,
			);
		}

		const enqueuePrompt = (
			text: string,
			attachmentRefs: ReadonlyArray<AttachmentRef> = [],
			reconnectAttempt = 0,
		): void => {
			const compactSnapshot = isCompactCommand(text)
				? startCompactSnapshot(null)
				: null;
			if (compactSnapshot !== null) {
				Queue.offerUnsafe(
					events,
					startCompactEvent({ providerId: "grok", snapshot: compactSnapshot }),
				);
			}
			const promptText =
				compactSnapshot !== null
					? text.trim()
					: prefixFirstPromptWithWorkspaceInstructions(
							workspaceInstructionsPending,
							text,
						);
			if (compactSnapshot === null) workspaceInstructionsPending = undefined;
			inflight = inflight
				.then(async () => {
					if (closed) return;
					if (terminalFailure) {
						Queue.offerUnsafe(events, {
							_tag: "Error",
							message:
								"Grok session is closed after repeated transport failures. Start a new session.",
							kind: "network",
							providerId: "grok",
						});
						return;
					}

					if (dead) {
						grokDiag("respawning grok child before send (previous child died)");
						try {
							const acquisition = await connectChild(acpSessionId);
							Queue.offerUnsafe(events, {
								_tag: "SessionCursor",
								cursor: acquisition.sessionId,
								strategy: "grok-session-id",
							});
						} catch (cause) {
							const reason =
								cause instanceof Error ? cause.message : String(cause);
							grokDiag("respawn failed", { reason });
							const reconnectKind =
								cause instanceof GrokProtocolError ? cause.kind : "transport";
							const failureAction = grokSessionFailureAction(reconnectKind);
							if (failureAction !== "continue") {
								if (failureAction === "terminal") {
									terminalFailure = true;
									lifecycle.transition("error");
								}
								Queue.offerUnsafe(events, {
									_tag: "Error",
									message: reason,
									kind: reconnectKind === "auth" ? "auth" : "generic",
									providerId: "grok",
								});
								return;
							}
							if (reconnectAttempt < 2) {
								enqueuePrompt(text, attachmentRefs, reconnectAttempt + 1);
								return;
							}
							terminalFailure = true;
							lifecycle.transition("error");
							if (!closed)
								Queue.offerUnsafe(events, {
									_tag: "Error",
									message: `Grok reconnect failed: ${reason}`,
									kind: "network",
									providerId: "grok",
								});
							return;
						}
					}
					const sid = acpSessionId;
					if (sid === null) return;
					lifecycle.transition("running");

					const finalPromptText = promptText;
					const prompt = await buildAcpPromptContent(
						finalPromptText,
						attachmentRefs,
						async (attachment) => {
							const [blob, file] = await Promise.all([
								Effect.runPromise(attachments.read(attachment.id)),
								Effect.runPromise(attachments.readPath(attachment.id)),
							]);
							if (blob === null) return null;
							return {
								bytes: blob.bytes,
								mimeType: blob.mimeType,
								...(file === null ? {} : { path: file.path }),
							};
						},
					);
					grokDiag("session/prompt starting", {
						permissionMode: currentMode,
						model: input.model,
					});
					try {
						await request(
							"session/prompt",
							{
								sessionId: sid,
								prompt,
							},
							null,
							(id) => {
								currentPromptRpcId = id;
							},
						);
						if (GROK_RPC_TRACE || GROK_DIAG) {
							process.stderr.write(`[grok.prompt] completed\n`);
						}
						grokDiag("session/prompt completed successfully");
						if (compactSnapshot !== null && !closed) {
							Queue.offerUnsafe(
								events,
								finishCompactEvent({
									itemId: compactSnapshot.itemId,
									providerId: "grok",
									snapshot: compactSnapshot,
									afterTokens: null,
								}),
							);
						}
					} catch (cause) {
						const reason =
							cause instanceof Error ? cause.message : String(cause);
						if (GROK_RPC_TRACE || GROK_DIAG) {
							process.stderr.write(`[grok.prompt] failed: ${reason}\n`);
						}
						grokDiag("session/prompt failed", { reason });
						const errorKind =
							cause instanceof GrokProtocolError ? cause.kind : "provider";
						const isCancellation = errorKind === "cancellation";
						const failureAction = grokSessionFailureAction(errorKind);
						const requiresUserAction = failureAction !== "continue";
						if (failureAction === "restart") {
							dead = true;
							try {
								await stopProviderProcess(child, { processGroup: true });
							} catch {}
						}
						if (failureAction === "terminal") terminalFailure = true;
						if (
							!isCancellation &&
							!requiresUserAction &&
							dead &&
							reconnectAttempt < 2
						) {
							enqueuePrompt(text, attachmentRefs, reconnectAttempt + 1);
							return;
						}
						if (failureAction === "continue" && dead && reconnectAttempt >= 2)
							terminalFailure = true;
						if (failureAction === "terminal" && lifecycle.current() !== "error")
							lifecycle.transition("error");
						if (!closed && !isCancellation) {
							Queue.offerUnsafe(events, {
								_tag: "Error",
								message: reason,
								kind:
									errorKind === "auth"
										? "auth"
										: errorKind === "transport"
											? "network"
											: "generic",
								providerId: "grok",
							});
						}
					} finally {
						currentPromptRpcId = null;

						if (!closed) {
							for (const ev of translator.flush())
								Queue.offerUnsafe(events, ev);
							for (const [
								providerSessionId,
								childTranslator,
							] of translatorsBySession) {
								for (const ev of childTranslator.flush()) {
									Queue.offerUnsafe(
										events,
										routeSubagentEvent(ev, providerSessionId),
									);
								}
							}
							Queue.offerUnsafe(events, { _tag: "Status", status: "idle" });
							if (lifecycle.current() === "running")
								lifecycle.transition("idle");
						}
					}
				})
				.catch(() => undefined);
		};

		if (input.initialPrompt !== undefined && input.initialPrompt.length > 0) {
			enqueuePrompt(input.initialPrompt);
		}

		const handle: GrokSessionHandle = {
			events: Stream.fromQueue(events),
			send: (text, attachmentRefs) =>
				Effect.sync(() => {
					enqueuePrompt(text, attachmentRefs ?? []);
				}),
			interrupt: () =>
				Effect.sync(() => {
					const sid = acpSessionId;
					if (sid === null) return;
					if (GROK_RPC_TRACE) {
						process.stderr.write(
							`[grok.interrupt] sid=${sid} pendingPrompt=${currentPromptRpcId ?? "(none)"}\n`,
						);
					}

					notify("session/cancel", { sessionId: sid });
					userQuestions.cancelAll("cancelled");
					releaseGatewayQuestions("cancelled");

					rejectCurrentPrompt("Interrupted by user");
					Queue.offerUnsafe(events, { _tag: "Status", status: "idle" });
				}),
			close: () =>
				Effect.gen(function* () {
					closed = true;
					for (const { rpcId } of pendingPlanResponses.values()) {
						writeMessage({
							jsonrpc: "2.0",
							id: rpcId,
							result: { outcome: "abandoned" },
						});
					}
					userQuestions.cancelAll("closed");
					releaseGatewayQuestions("closed");
					pendingPlanResponses.clear();
					if (lifecycle.current() !== "closed") lifecycle.transition("closed");
					rpc.rejectAll(new Error("Grok session closed"));
					try {
						child.stdin.end();
					} catch {}
					yield* Effect.promise(() =>
						stopProviderProcess(child, { processGroup: true }),
					);
					rl.close();
					yield* Effect.promise(() => mcpGatewaySession.close());
					yield* Effect.promise(() => stdioMcpFallback.close());
					yield* Queue.end(events);
				}),
			setPermissionMode: (mode) =>
				Effect.promise(async () => {
					if (mode === currentMode) return;
					if (acpSessionId === null) return;
					await request("session/set_mode", {
						sessionId: acpSessionId,
						modeId: mapGrokMode(mode),
					});
				}),
			answerQuestion: (itemId, answers) =>
				Effect.try({
					try: () => {
						const gatewayResolve = gatewayQuestionResponses.get(itemId);
						if (gatewayResolve !== undefined) {
							gatewayQuestionResponses.take(itemId)(answers);
							return;
						}
						if (userQuestions.answer(itemId, answers)) {
							lifecycle.transition("running");
						}
					},
					catch: (cause) =>
						cause instanceof Error ? cause : new Error(String(cause)),
				}),
			cancelQuestion: (itemId) =>
				Effect.try({
					try: () => {
						const gatewayResolve = gatewayQuestionResponses.get(itemId);
						if (gatewayResolve !== undefined) {
							gatewayQuestionResponses.take(itemId)(null);
							return;
						}
						userQuestions.cancel(itemId);
					},
					catch: (cause) =>
						cause instanceof Error ? cause : new Error(String(cause)),
				}),
			acknowledgeQuestionAnswer: (itemId) =>
				Effect.sync(() => {
					userQuestions.acknowledge(itemId);
				}),
			respondToPlan: (toolCallId, outcome, feedback) =>
				Effect.try({
					try: () => {
						const pending = pendingPlanResponses.get(toolCallId);
						if (pending === undefined)
							throw new Error(`No pending Grok plan approval ${toolCallId}.`);
						writeMessage({
							jsonrpc: "2.0",
							id: pending.rpcId,
							result: {
								outcome,
								...(feedback === undefined || feedback.trim().length === 0
									? {}
									: { feedback: feedback.trim() }),
							},
						});
						pendingPlanResponses.delete(toolCallId);
						lifecycle.transition("running");
					},
					catch: (cause) =>
						cause instanceof Error ? cause : new Error(String(cause)),
				}),
			acknowledgeProviderEventCursor: (cursor) =>
				Effect.sync(() => eventCursor.commit(cursor)),
			releaseProviderEventCursor: (cursor) =>
				Effect.sync(() => eventCursor.release(cursor)),
			getGoal: () => Effect.sync(() => currentGoal),
			setGoal: (goalInput, options) =>
				Effect.sync(() => {
					const now = Date.now();
					const objective = (
						goalInput.objective ??
						currentGoal?.objective ??
						""
					).trim();
					const status = goalInput.status ?? currentGoal?.status ?? "active";
					const previousStatus = currentGoal?.status;
					const goal = ThreadGoal.make({
						threadId: acpSessionId ?? "",
						objective,
						status,
						tokenBudget:
							goalInput.tokenBudget !== undefined
								? goalInput.tokenBudget
								: (currentGoal?.tokenBudget ?? null),

						tokensUsed: currentGoal?.tokensUsed ?? 0,
						timeUsedSeconds: currentGoal?.timeUsedSeconds ?? 0,
						createdAt: currentGoal?.createdAt ?? now,
						updatedAt: now,
					});
					if (
						objective.length > 0 &&
						(currentGoal === null ||
							(goalInput.objective !== undefined &&
								objective !== currentGoal.objective))
					) {
						const budget = goal.tokenBudget;
						enqueuePrompt(
							`/goal ${objective}${budget === null ? "" : ` --budget ${budget}`}`,
						);
					} else if (status === "paused" && previousStatus !== "paused") {
						enqueuePrompt("/goal pause");
					} else if (
						status === "active" &&
						(options?.execute === true || previousStatus === "paused")
					) {
						enqueuePrompt("/goal resume");
					}
					return goal;
				}),
			clearGoal: () =>
				Effect.sync(() => {
					enqueuePrompt("/goal clear");
				}),
		};
		return handle;
	});
