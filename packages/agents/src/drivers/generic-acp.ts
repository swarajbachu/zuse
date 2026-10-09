import { type AcpLaunch, launchAcpProcess } from "@zuse/acp/process";
import {
	type AgentSessionId,
	AgentSessionStartError,
	type PermissionMode,
	type StartSessionInput,
} from "@zuse/contracts";
import { type Cause, Effect, Exit, Queue, Stream } from "effect";
import { makeAcpPermissionContext } from "../kernel/acp-permission-context.ts";
import { AttachmentService } from "../kernel/attachment-service.ts";
import type {
	ProviderDriverEvent,
	ProviderSessionHandle,
} from "../kernel/driver.ts";
import { issueProviderMcpSession } from "../kernel/provider-mcp-session.ts";
import { makeStdioMcpFallback } from "../kernel/stdio-mcp-fallback.ts";
import { prefixFirstPromptWithWorkspaceInstructions } from "../kernel/workspace-instructions.ts";
import {
	acpSessionInventory,
	decodeAcpSession,
	initializeAcp,
} from "./acp/discovery.ts";
import { handleFsRequest } from "./acp/fs.ts";
import {
	handleAcpNativePermissionRequest,
	isAcpNativePermissionMethod,
} from "./acp/native-permission.ts";
import { replyToAcpRequest } from "./acp/request-reply.ts";
import { createAcpTerminalSession } from "./acp/terminal.ts";
import { createAcpTranslator } from "./acp/translate.ts";
import { makeAcpUserQuestionRegistry } from "./acp/user-question.ts";
import { buildAcpPromptContent } from "./acp-image-content.ts";
import type { BrowserSend } from "./browser-tools.ts";
import type { GetRuntimeMode, RequestPermission } from "./claude.ts";
import type { OrchestrationSessionTools } from "./orchestration-tools.ts";
import { pluginCliEnv } from "./plugin-tools.ts";

export const startGenericAcpSession = Effect.fn("ACP.start")(function* (
	input: StartSessionInput,
	cwd: string,
	launch: AcpLaunch,
	sessionId: AgentSessionId,
	requestPermission: RequestPermission,
	getRuntimeMode: GetRuntimeMode,
	browserSend: BrowserSend,
	mcpCommand: string,
	orchestrationTools: OrchestrationSessionTools | null,
	resumeCursor: string | null,
): Effect.fn.Return<
	ProviderSessionHandle,
	AgentSessionStartError,
	AttachmentService
> {
	const attachmentsService = yield* AttachmentService;
	const runtime = yield* Effect.context<never>();
	const events = yield* Queue.make<ProviderDriverEvent, Cause.Done>();
	const emit = (event: ProviderDriverEvent) => {
		Queue.offerUnsafe(events, event);
	};
	let closed = false;
	let mode: PermissionMode = input.permissionMode ?? "default";
	let active = false;
	let supportsImages = false;
	let turnGeneration = 0;
	let interrupted = false;
	let pendingInstructions = input.workspaceInstructions;
	const permission = {
		requestPermission: (
			kind: Parameters<RequestPermission>[1],
			options: Parameters<RequestPermission>[2],
		) => requestPermission(sessionId, kind, options),
		getRuntimeMode,
		getPermissionMode: () => mode,
	};

	const gateway = yield* issueProviderMcpSession({
		providerId: input.providerId,
		sessionId,
		cwd,
		browserSend,
		...permission,
		orchestrationTools,
	});
	const executionEnv = {
		...input.executionEnv,
		...launch.env,
		...pluginCliEnv(gateway.endpoint, gateway.token),
	};
	const context = makeAcpPermissionContext({
		executionEnv,
		unsetExecutionEnv: launch.unsetEnv,
		cwd,
		sessionId,
		projectId: input.folderId,
		...permission,
	});
	const fallback = makeStdioMcpFallback({
		command: mcpCommand,
		endpoint: gateway.endpoint,
		token: gateway.token,
	});
	const translator = createAcpTranslator("generic", {
		onCheckpoint: (batch) => batch.forEach(emit),
	});
	const terminals = createAcpTerminalSession(context);
	const releaseTerminals = terminals.close;
	let notifications: Promise<void> = Promise.resolve();
	const connection = launchAcpProcess(
		{
			...launch,
			env: {
				...executionEnv,
				...launch.env,
			},
		},
		cwd,
		(message) => {
			if (message.method === "session/update") {
				const params = message.params as
					| { sessionId?: string; update?: unknown }
					| undefined;
				if (
					params?.update &&
					(!acpSessionId || params.sessionId === acpSessionId)
				)
					notifications = notifications
						.then(async () => {
							const update = await terminals.resolveUpdate(params.update);
							translator.translate(update).forEach(emit);
						})
						.catch((error) => {
							emit({ _tag: "Error", message: String(error) });
						});
				return;
			}
			if (message.id == null || !message.method) return;
			const method = message.method;
			const handle = async () => {
				if (isAcpNativePermissionMethod(method))
					return handleAcpNativePermissionRequest(
						method,
						message.params,
						permission,
					);
				if (method.startsWith("fs/"))
					return handleFsRequest(method, message.params, context());
				if (method.startsWith("terminal/"))
					return terminals.handle(method, message.params);
				throw new Error(`Unsupported ACP client request: ${method}`);
			};
			if (
				questions.handleRequest(method, message.params, message.id) !==
				"unhandled"
			)
				return;
			replyToAcpRequest(
				(message) => connection.rpc.send(message),
				message.id,
				handle(),
			);
		},
		(error) => {
			const unexpected = !closed;
			closed = true;
			questions.discardAll();
			void notifications.finally(() => {
				translator.flush().forEach(emit);
				translator.finishTools("Agent connection closed").forEach(emit);
				if (unexpected) {
					emit({ _tag: "Error", message: error.message });
					emit({ _tag: "Status", status: "error" });
				}
				Queue.endUnsafe(events);
				void releaseTerminals();
				void fallback.close();
				void gateway.close();
			});
		},
	);
	const questions = makeAcpUserQuestionRegistry({
		send: (message) => connection.rpc.send(message),
		emit,
		release: (itemId, reason) =>
			emit({ _tag: "QuestionCallbackReleased", itemId, reason }),
	});
	let acpSessionId: string | null = null;
	const request = (method: string, params: unknown) =>
		connection.rpc.request(method, params);
	const stop = async () => {
		closed = true;
		await notifications;
		questions.cancelAll("closed");
		connection.close();
		await releaseTerminals();
		await fallback.close();
		await gateway.close();
		Queue.endUnsafe(events);
	};
	yield* Effect.tryPromise({
		try: async () => {
			const init = await initializeAcp(request);
			supportsImages =
				init.agentCapabilities?.promptCapabilities?.image === true;
			if (resumeCursor && !init.agentCapabilities?.loadSession)
				throw new Error(
					"This ACP agent cannot resume saved sessions. Start a new conversation.",
				);
			const mcpServers =
				launch.mcpEnabled === false
					? []
					: init.agentCapabilities?.mcpCapabilities?.http
						? [gateway.serverConfig]
						: await fallback.ensure();
			const result = decodeAcpSession(
				await request(resumeCursor ? "session/load" : "session/new", {
					cwd,
					mcpServers,
					...(resumeCursor ? { sessionId: resumeCursor } : {}),
				}),
				resumeCursor,
			);
			acpSessionId = result.sessionId;
			const inventory = acpSessionInventory(result);
			if (input.model && input.model !== "default") {
				if (!inventory.models.some((model) => model.id === input.model))
					throw new Error(
						"The selected model is no longer available from this ACP agent.",
					);
				await request(
					inventory.modelConfigId
						? "session/set_config_option"
						: "session/set_model",
					{
						sessionId: acpSessionId,
						...(inventory.modelConfigId
							? { configId: inventory.modelConfigId, value: input.model }
							: { modelId: input.model }),
					},
				);
			}
			const selectedMode = input.modelOptions?.acpMode;
			if (selectedMode) {
				if (!inventory.modes.some((mode) => mode.id === selectedMode))
					throw new Error("The selected ACP mode is unavailable.");
				await request(
					inventory.modeConfigId
						? "session/set_config_option"
						: "session/set_mode",
					{
						sessionId: acpSessionId,
						...(inventory.modeConfigId
							? { configId: inventory.modeConfigId, value: selectedMode }
							: { modeId: selectedMode }),
					},
				);
			}
			emit({
				_tag: "Started",
				sessionId,
				providerId: input.providerId,
				mode: "sdk",
			});
			emit({
				_tag: "SessionCursor",
				cursor: acpSessionId,
				strategy: "grok-session-id",
			});
			if (resumeCursor) emit({ _tag: "Status", status: "idle" });
		},
		catch: (cause) =>
			new AgentSessionStartError({
				providerId: input.providerId,
				reason: cause instanceof Error ? cause.message : String(cause),
			}),
	}).pipe(
		Effect.onExit((exit) =>
			Exit.isFailure(exit) ? Effect.promise(stop) : Effect.void,
		),
	);
	const send: ProviderSessionHandle["send"] = (text, attachments) =>
		Effect.sync(() => {
			if (closed || active) {
				emit({
					_tag: "Error",
					message: closed
						? "ACP session is closed"
						: "ACP agent is still processing the previous request",
				});
				return;
			}
			if (attachments?.length && !supportsImages) {
				emit({
					_tag: "Error",
					message: "This ACP agent does not support image attachments.",
				});
				return;
			}
			active = true;
			interrupted = false;
			turnGeneration++;
			const prompt = prefixFirstPromptWithWorkspaceInstructions(
				pendingInstructions,
				text,
			);
			pendingInstructions = undefined;
			emit({ _tag: "Status", status: "running" });
			void buildAcpPromptContent(prompt, attachments ?? [], (attachment) =>
				Effect.runPromiseWith(runtime)(attachmentsService.read(attachment.id)),
			)
				.then((content) =>
					connection.rpc.request(
						"session/prompt",
						{ sessionId: acpSessionId, prompt: content },
						{ timeoutMs: null },
					),
				)
				.catch((error) => {
					if (!closed && !interrupted)
						emit({ _tag: "Error", message: String(error) });
				})
				.finally(async () => {
					await notifications;
					active = false;
					translator.flush().forEach(emit);
					translator
						.finishTools(
							interrupted
								? "Interrupted"
								: "Agent ended the turn before completing this tool",
						)
						.forEach(emit);
					if (!closed) emit({ _tag: "Status", status: "idle" });
				});
		});
	const handle: ProviderSessionHandle = {
		events: Stream.fromQueue(events),
		send,
		interrupt: () =>
			Effect.sync(() => {
				if (!active || closed) return;
				interrupted = true;
				translator.finishTools("Interrupted").forEach(emit);
				connection.rpc.notify("session/cancel", { sessionId: acpSessionId });
				questions.cancelAll("cancelled");
				emit({ _tag: "Interrupted" });
				const generation = turnGeneration;
				const timer = setTimeout(() => {
					if (!active || turnGeneration !== generation || closed) return;
					// Report the forced stop like an unexpected close, so consumers
					// see a terminal status instead of a silently ended session.
					emit({
						_tag: "Error",
						message:
							"The agent did not stop after being interrupted, so its process was ended.",
					});
					emit({ _tag: "Status", status: "error" });
					void stop();
				}, 5000);
				timer.unref();
			}),
		close: () => Effect.promise(stop),
		setPermissionMode: (next) =>
			Effect.sync(() => {
				mode = next;
				emit({ _tag: "PermissionModeChanged", mode });
			}),
		answerQuestion: (id, answers) =>
			Effect.try({
				try: () => questions.answer(id, answers),
				catch: (cause) => new Error(String(cause)),
			}),
		cancelQuestion: (id) =>
			Effect.try({
				try: () => questions.cancel(id),
				catch: (cause) => new Error(String(cause)),
			}),
		acknowledgeQuestionAnswer: (id) =>
			Effect.sync(() => questions.acknowledge(id)),
	};
	if (input.initialPrompt) yield* send(input.initialPrompt);
	return handle;
});
