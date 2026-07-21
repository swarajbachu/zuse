import { join } from "node:path";

import {
	Agent,
	AgentNotFoundError,
	type AgentOptions,
	AuthenticationError,
	CursorSdkError,
	getDefaultSdkStateRoot,
	JsonlLocalAgentStore,
	type McpServerConfig,
	type ModelSelection,
	type Run,
	type SDKMessage,
	type SDKUserMessage,
} from "@cursor/sdk";
import {
	type AgentEvent,
	type AgentItemId,
	type AgentSessionId,
	AgentSessionStartError,
	type AttachmentRef,
	type FileRef,
	type PermissionMode,
	resolveModelSlug,
	type SkillRef,
	type StartSessionInput,
} from "@zuse/contracts";
import { type Cause, Effect, Queue, Result, Stream } from "effect";

import {
	AttachmentService,
	type AttachmentServiceShape,
} from "../kernel/attachment-service.ts";
import type { ProviderSessionHandle } from "../kernel/driver.ts";
import { normalizeNativeToolName } from "../kernel/native-tool-name.ts";
import { appendStreamText } from "../kernel/stream-text.ts";
import { prefixFirstPromptWithWorkspaceInstructions } from "../kernel/workspace-instructions.ts";
import type { ResolvedMcpServer } from "../user-mcp/types.ts";

const SDK_START_TIMEOUT_MS = 30_000;
const STORE_DIRECTORY = "zuse-jsonl";

export interface CursorSessionHandle extends ProviderSessionHandle {
	readonly events: Stream.Stream<AgentEvent>;
	readonly updateMcpServers: NonNullable<
		ProviderSessionHandle["updateMcpServers"]
	>;
}

export interface CursorSdkTranslationState {
	readonly seenToolCalls: Set<string>;
	messageSequence: number;
	thinkingSequence: number;
	assistantBuffer: {
		readonly itemId: AgentItemId;
		text: string;
		emittedText: string;
	} | null;
	thinkingBuffer: {
		readonly itemId: AgentItemId;
		text: string;
		emittedText: string;
	} | null;
	model: string;
}

const itemId = (value: string): AgentItemId => value as AgentItemId;

const errorMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const isAuthenticationFailure = (cause: unknown): boolean =>
	cause instanceof AuthenticationError ||
	(cause instanceof CursorSdkError && cause.status === 401) ||
	/(?:invalid|expired|revoked).*api key|api key.*(?:invalid|expired|revoked)|unauthori[sz]ed|\b401\b/i.test(
		errorMessage(cause),
	);

const isNetworkFailure = (cause: unknown): boolean =>
	(cause instanceof CursorSdkError &&
		(cause.isRetryable ||
			cause.status === 408 ||
			(cause.status ?? 0) >= 500)) ||
	/network|fetch failed|timed?\s*out|econn|enotfound|socket|offline|service unavailable/i.test(
		errorMessage(cause),
	);

const formatToolResult = (result: unknown): string => {
	if (typeof result === "string") return result;
	if (result === undefined) return "";
	return JSON.stringify(result);
};

const normalizeCursorToolInput = (tool: string, input: unknown): unknown => {
	if (tool !== "Read" || !isRecord(input)) return input;
	const path = input.file_path ?? input.filePath ?? input.path;
	if (typeof path !== "string") return input;
	const { filePath: _filePath, path: _path, ...rest } = input;
	return { ...rest, file_path: path };
};

const normalizeCursorToolResult = (tool: string, result: unknown): unknown => {
	if (tool !== "Read" || !isRecord(result)) return result;
	const value = isRecord(result.value) ? result.value : result;
	return typeof value.content === "string" ? value.content : result;
};

const isAutoReviewDenial = (result: unknown): boolean =>
	/(?:auto[ -]?review|classifier).*(?:block|deni)|(?:block|deni).*(?:auto[ -]?review|classifier)/i.test(
		formatToolResult(result),
	);

const blockedToolOutput = (result: unknown): string => {
	const detail = formatToolResult(result).trim();
	const guidance =
		"Blocked by automatic review. Adjust the request and try a safer operation; it was not retried.";
	return detail.length > 0 ? `${detail}\n\n${guidance}` : guidance;
};

const withTimeout = async <A>(
	promise: Promise<A>,
	timeoutMs: number,
	label: string,
	onLateResolve?: (value: A) => void,
): Promise<A> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	void promise.then(
		(value) => {
			if (timedOut) onLateResolve?.(value);
		},
		() => undefined,
	);
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					timedOut = true;
					reject(new Error(`${label} timed out after ${timeoutMs / 1_000}s.`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
};

const modelSelection = (model: string | undefined): ModelSelection => {
	const resolved = resolveModelSlug("cursor", model ?? "composer-2");
	return { id: resolved === "default" ? "composer-2" : resolved };
};

const emitAssistant = (
	state: CursorSdkTranslationState,
	clear: boolean,
): AgentEvent[] => {
	const pending = state.assistantBuffer;
	if (pending === null) return [];
	if (clear) state.assistantBuffer = null;
	if (pending.text === pending.emittedText) return [];
	pending.emittedText = pending.text;
	return [
		{
			_tag: "AssistantMessage",
			itemId: pending.itemId,
			text: pending.text,
		},
	];
};

const emitThinking = (
	state: CursorSdkTranslationState,
	clear: boolean,
): AgentEvent[] => {
	const pending = state.thinkingBuffer;
	if (pending === null) return [];
	if (clear) state.thinkingBuffer = null;
	if (pending.text === pending.emittedText) return [];
	pending.emittedText = pending.text;
	return [
		{
			_tag: "Thinking",
			itemId: pending.itemId,
			text: pending.text,
			redacted: false,
		},
	];
};

const flushAssistant = (state: CursorSdkTranslationState): AgentEvent[] =>
	emitAssistant(state, true);

const flushThinking = (state: CursorSdkTranslationState): AgentEvent[] =>
	emitThinking(state, true);

/** Drain buffered SDK deltas at a run boundary. */
export const flushCursorSdkMessages = (
	state: CursorSdkTranslationState,
): ReadonlyArray<AgentEvent> => [
	...flushThinking(state),
	...flushAssistant(state),
];

/** Translate one SDK stream message into the provider-neutral event contract. */
export const translateCursorSdkMessage = (
	message: SDKMessage,
	state: CursorSdkTranslationState,
): ReadonlyArray<AgentEvent> => {
	switch (message.type) {
		case "system":
			return [
				...flushCursorSdkMessages(state),
				{ _tag: "Auth", sdkConfigured: true },
				{ _tag: "Capabilities", capabilities: message.tools ?? [] },
			];
		case "assistant": {
			const translated: AgentEvent[] = [...flushThinking(state)];
			for (const block of message.message.content) {
				if (block.type === "text") {
					state.assistantBuffer ??= {
						itemId: itemId(
							`${message.run_id}:assistant:${++state.messageSequence}`,
						),
						text: "",
						emittedText: "",
					};
					state.assistantBuffer.text = appendStreamText(
						state.assistantBuffer.text,
						block.text,
					);
					continue;
				}
				translated.push(...flushAssistant(state));
				if (state.seenToolCalls.has(block.id)) continue;
				state.seenToolCalls.add(block.id);
				const tool = normalizeNativeToolName(block.name);
				translated.push({
					_tag: "ToolUse" as const,
					itemId: itemId(block.id),
					tool,
					input: normalizeCursorToolInput(tool, block.input),
				});
			}
			translated.push(...emitAssistant(state, false));
			return translated;
		}
		case "tool_call": {
			const events: AgentEvent[] = [...flushCursorSdkMessages(state)];
			const tool = normalizeNativeToolName(message.name);
			if (!state.seenToolCalls.has(message.call_id)) {
				state.seenToolCalls.add(message.call_id);
				events.push({
					_tag: "ToolUse",
					itemId: itemId(message.call_id),
					tool,
					input: normalizeCursorToolInput(tool, message.args ?? {}),
				});
			}
			if (message.status !== "running") {
				events.push({
					_tag: "ToolResult",
					itemId: itemId(message.call_id),
					output:
						message.status === "error" && isAutoReviewDenial(message.result)
							? blockedToolOutput(message.result)
							: formatToolResult(
									normalizeCursorToolResult(tool, message.result),
								),
					isError: message.status === "error",
				});
			}
			return events;
		}
		case "thinking": {
			const events = flushAssistant(state);
			state.thinkingBuffer ??= {
				itemId: itemId(
					`${message.run_id}:thinking:${++state.thinkingSequence}`,
				),
				text: "",
				emittedText: "",
			};
			state.thinkingBuffer.text = appendStreamText(
				state.thinkingBuffer.text,
				message.text,
			);
			events.push(...emitThinking(state, false));
			return events;
		}
		case "status": {
			const terminal =
				message.status !== "CREATING" && message.status !== "RUNNING";
			return [
				...(terminal ? flushCursorSdkMessages(state) : []),
				{
					_tag: "Status",
					status:
						message.status === "CREATING"
							? "starting"
							: message.status === "RUNNING"
								? "running"
								: message.status === "ERROR"
									? "error"
									: "idle",
				},
			];
		}
		case "usage":
			return [
				...flushCursorSdkMessages(state),
				{
					_tag: "UsageDelta",
					inputTokens: message.usage.inputTokens,
					outputTokens: message.usage.outputTokens,
					cacheReadTokens: message.usage.cacheReadTokens,
					cacheCreationTokens: message.usage.cacheWriteTokens,
					model: state.model,
				},
			];
		case "request":
			return [
				...flushCursorSdkMessages(state),
				{
					_tag: "ProviderNotificationMetadata",
					promptId: message.request_id,
					isReplay: false,
				},
			];
		case "user":
		case "task":
			return [];
	}
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Convert the provider-neutral MCP wire array to the SDK's named map. */
export const normalizeCursorMcpServers = (
	servers: ReadonlyArray<unknown>,
): Record<string, McpServerConfig> => {
	const normalized: Record<string, McpServerConfig> = {};
	for (const [index, value] of servers.entries()) {
		if (!isRecord(value)) continue;
		const nested = isRecord(value.config) ? value.config : value;
		const nameCandidate = value.name ?? value.id;
		const name =
			typeof nameCandidate === "string" && nameCandidate.trim().length > 0
				? nameCandidate
				: `server-${index + 1}`;
		if (typeof nested.command === "string") {
			normalized[name] = {
				type: "stdio",
				command: nested.command,
				...(Array.isArray(nested.args) &&
				nested.args.every((arg) => typeof arg === "string")
					? { args: nested.args as string[] }
					: {}),
				...(isRecord(nested.env) &&
				Object.values(nested.env).every((entry) => typeof entry === "string")
					? { env: nested.env as Record<string, string> }
					: {}),
				...(typeof nested.cwd === "string" ? { cwd: nested.cwd } : {}),
			};
		} else if (typeof nested.url === "string") {
			normalized[name] = {
				type: nested.type === "sse" ? "sse" : "http",
				url: nested.url,
				...(isRecord(nested.headers) &&
				Object.values(nested.headers).every(
					(entry) => typeof entry === "string",
				)
					? { headers: nested.headers as Record<string, string> }
					: {}),
			};
		}
	}
	return normalized;
};

const buildSdkMessage = async (
	text: string,
	attachmentRefs: ReadonlyArray<AttachmentRef>,
	attachments: AttachmentServiceShape,
): Promise<string | SDKUserMessage> => {
	const images = (
		await Promise.all(
			attachmentRefs.map(async (ref) => {
				if (!ref.mimeType.toLowerCase().startsWith("image/")) return null;
				const resolved = await Effect.runPromise(attachments.read(ref.id));
				if (resolved === null) return null;
				return {
					data: Buffer.from(resolved.bytes).toString("base64"),
					mimeType: resolved.mimeType,
				};
			}),
		)
	).filter((image): image is NonNullable<typeof image> => image !== null);
	return images.length === 0 ? text : { text, images };
};

const appendReferences = (
	text: string,
	fileRefs: ReadonlyArray<FileRef>,
	skillRefs: ReadonlyArray<SkillRef>,
): string => {
	const lines: string[] = [];
	if (fileRefs.length > 0) {
		lines.push(
			"Referenced workspace paths:",
			...fileRefs.map((file) => `- ${file.relPath}`),
		);
	}
	if (skillRefs.length > 0) {
		lines.push(
			"Requested skills:",
			...skillRefs.map((skill) =>
				skill.args.trim().length > 0
					? `- /${skill.name} ${skill.args.trim()}`
					: `- /${skill.name}`,
			),
		);
	}
	return lines.length === 0 ? text : `${text}\n\n${lines.join("\n")}`;
};

export const startCursorSession = (
	input: StartSessionInput,
	cwd: string,
	apiKey: string,
	sessionId: AgentSessionId,
	resumeCursor: string | null = null,
	initialMcpServers: ReadonlyArray<ResolvedMcpServer> = [],
): Effect.Effect<
	CursorSessionHandle,
	AgentSessionStartError,
	AttachmentService
> =>
	Effect.gen(function* () {
		const attachments = yield* AttachmentService;
		const events = yield* Queue.make<AgentEvent, Cause.Done>();
		const store = new JsonlLocalAgentStore(
			join(getDefaultSdkStateRoot(cwd), STORE_DIRECTORY),
		);
		const selection = modelSelection(input.model);
		const options: AgentOptions = {
			apiKey,
			model: selection,
			local: {
				cwd,
				store,
				autoReview: true,
				sandboxOptions: { enabled: true },
				settingSources: ["project", "user", "team", "mdm", "plugins"],
				enableAgentRetries: true,
			},
			mode:
				input.permissionMode === "plan"
					? ("plan" as const)
					: ("agent" as const),
		};

		const result = yield* Effect.result(
			Effect.tryPromise({
				try: async () => {
					if (resumeCursor !== null && resumeCursor.trim().length > 0) {
						try {
							const agent = await withTimeout(
								Agent.resume(resumeCursor, options),
								SDK_START_TIMEOUT_MS,
								"Local agent resume",
								(agent) => agent.close(),
							);
							return { agent, resumed: true };
						} catch (cause) {
							if (
								!(cause instanceof AgentNotFoundError) &&
								!/(?:stale|corrupt|not found|unknown agent)/i.test(
									errorMessage(cause),
								)
							) {
								throw cause;
							}
							const agent = await withTimeout(
								Agent.create(options),
								SDK_START_TIMEOUT_MS,
								"Local agent startup",
								(agent) => agent.close(),
							);
							return { agent, resumed: false };
						}
					}
					const agent = await withTimeout(
						Agent.create(options),
						SDK_START_TIMEOUT_MS,
						"Local agent startup",
						(agent) => agent.close(),
					);
					return { agent, resumed: false };
				},
				catch: (cause) => cause,
			}),
		);
		if (Result.isFailure(result)) {
			const cause = result.failure;
			const guidance = isAuthenticationFailure(cause)
				? "API key rejected. Open provider settings and replace the saved key."
				: isNetworkFailure(cause)
					? "Could not reach the provider. Check your connection and try again."
					: errorMessage(cause);
			return yield* new AgentSessionStartError({
				providerId: "cursor",
				reason: guidance,
			});
		}
		const { agent, resumed } = result.success;

		Queue.offerUnsafe(events, {
			_tag: "Started",
			sessionId,
			providerId: "cursor",
			mode: "sdk",
		});
		Queue.offerUnsafe(events, {
			_tag: "SessionCursor",
			cursor: agent.agentId,
			strategy: "cursor-session-id",
		});
		if (!resumed && resumeCursor !== null) {
			Queue.offerUnsafe(events, {
				_tag: "Status",
				status: "idle",
			});
		}

		let closed = false;
		let interrupted = false;
		let cancellationGeneration = 0;
		let activeRun: Run | null = null;
		let currentMode: PermissionMode = input.permissionMode ?? "default";
		let workspaceInstructions = input.workspaceInstructions;
		let mcpServers = normalizeCursorMcpServers(initialMcpServers);
		let inflight = Promise.resolve();
		const translationState: CursorSdkTranslationState = {
			seenToolCalls: new Set(),
			messageSequence: 0,
			thinkingSequence: 0,
			assistantBuffer: null,
			thinkingBuffer: null,
			model: selection.id,
		};

		const enqueue = (
			text: string,
			attachmentRefs: ReadonlyArray<AttachmentRef> = [],
			fileRefs: ReadonlyArray<FileRef> = [],
			skillRefs: ReadonlyArray<SkillRef> = [],
		): void => {
			inflight = inflight
				.then(async () => {
					if (closed) return;
					interrupted = false;
					const runGeneration = cancellationGeneration;
					translationState.seenToolCalls.clear();
					Queue.offerUnsafe(events, { _tag: "Status", status: "running" });
					const withInstructions = prefixFirstPromptWithWorkspaceInstructions(
						workspaceInstructions,
						text,
					);
					workspaceInstructions = undefined;
					const prompt = appendReferences(
						withInstructions,
						fileRefs,
						skillRefs,
					);
					const sdkMessage = await buildSdkMessage(
						prompt,
						attachmentRefs,
						attachments,
					);
					const run = await agent.send(sdkMessage, {
						model: selection,
						mode: currentMode === "plan" ? "plan" : "agent",
						...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
					});
					if (closed || runGeneration !== cancellationGeneration) {
						await run.cancel().catch(() => undefined);
						if (!closed) {
							Queue.offerUnsafe(events, { _tag: "Interrupted" });
							Queue.offerUnsafe(events, {
								_tag: "Completed",
								reason: "interrupted",
							});
						}
						return;
					}
					activeRun = run;
					for await (const message of run.stream()) {
						if (closed) break;
						for (const event of translateCursorSdkMessage(
							message,
							translationState,
						)) {
							Queue.offerUnsafe(events, event);
						}
					}
					for (const event of flushCursorSdkMessages(translationState)) {
						Queue.offerUnsafe(events, event);
					}
					const result = await run.wait();
					activeRun = null;
					if (interrupted || result.status === "cancelled") {
						Queue.offerUnsafe(events, { _tag: "Interrupted" });
						Queue.offerUnsafe(events, {
							_tag: "Completed",
							reason: "interrupted",
						});
					} else if (result.status === "error") {
						Queue.offerUnsafe(events, {
							_tag: "Error",
							message: result.error?.message ?? "The local agent run failed.",
							providerId: "cursor",
						});
						Queue.offerUnsafe(events, {
							_tag: "Completed",
							reason: "error",
						});
					} else {
						Queue.offerUnsafe(events, { _tag: "Completed", reason: "ended" });
					}
				})
				.catch((cause) => {
					activeRun = null;
					if (closed) return;
					for (const event of flushCursorSdkMessages(translationState)) {
						Queue.offerUnsafe(events, event);
					}
					if (interrupted) {
						Queue.offerUnsafe(events, { _tag: "Interrupted" });
						Queue.offerUnsafe(events, {
							_tag: "Completed",
							reason: "interrupted",
						});
						return;
					}
					Queue.offerUnsafe(events, {
						_tag: "Error",
						message: errorMessage(cause),
						kind: isAuthenticationFailure(cause)
							? "auth"
							: isNetworkFailure(cause)
								? "network"
								: "generic",
						providerId: "cursor",
					});
					Queue.offerUnsafe(events, { _tag: "Completed", reason: "error" });
				})
				.finally(() => {
					if (!closed)
						Queue.offerUnsafe(events, { _tag: "Status", status: "idle" });
				});
		};

		if (input.initialPrompt !== undefined && input.initialPrompt.length > 0) {
			enqueue(input.initialPrompt);
		}

		return {
			events: Stream.fromQueue(events),
			send: (text, attachmentRefs, fileRefs, skillRefs) =>
				Effect.sync(() => enqueue(text, attachmentRefs, fileRefs, skillRefs)),
			interrupt: () =>
				Effect.promise(async () => {
					cancellationGeneration += 1;
					interrupted = true;
					await activeRun?.cancel();
				}),
			close: () =>
				Effect.promise(async () => {
					if (closed) return;
					closed = true;
					cancellationGeneration += 1;
					await activeRun?.cancel().catch(() => undefined);
					agent.close();
					Queue.endUnsafe(events);
				}),
			setPermissionMode: (mode) =>
				Effect.sync(() => {
					currentMode = mode;
					Queue.offerUnsafe(events, { _tag: "PermissionModeChanged", mode });
				}),
			answerQuestion: () => Effect.void,
			updateMcpServers: (servers) =>
				Effect.sync(() => {
					mcpServers = normalizeCursorMcpServers(servers);
				}),
		};
	});
