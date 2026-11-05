import { createHash } from "node:crypto";
import {
	ORCHESTRATION_READ_LIMIT,
	ORCHESTRATION_TEXT_LIMIT,
	type OrchestrationReadInput,
} from "@zuse/agents/drivers/orchestration-discovery";
import {
	buildOrchestrationTools,
	ORCHESTRATION_MCP_TOOLS,
	type OrchestrationSessionTools,
	type OrchestrationToolDeps,
	type ReadThreadResult,
} from "@zuse/agents/drivers/orchestration-tools";
import type {
	SessionWaitInput,
	SessionWaitOptions,
	SessionWaitResult,
} from "@zuse/contracts";
import {
	type AutonomyLevel,
	bundledResolvedModelCatalog,
	type Chat,
	type ChatId,
	defaultModelFor,
	type FolderId,
	type Message,
	type MessageContent,
	type ProviderId,
	type ResolvedModelCatalog,
	type Session,
	type SessionId,
	type SettingsFile,
	type Worktree,
	type WorktreeCreateSource,
	type WorktreeId,
} from "@zuse/contracts";
import type { DelegationOrigin } from "@zuse/domain/agent-engine/delegation";
import {
	prepareGenerativeUiSpec,
	UI_SPEC_VERSION,
} from "@zuse/utils/generative-ui";
import { Context, Effect, Option } from "effect";
import { AutomationAgentRouter } from "../../automation/agent-tools.ts";
import { masterPrompt } from "../../master/state.ts";
import { MasterStore } from "../../master/store.ts";
import { MasterToolRouter } from "../../master/tool-router.ts";
import {
	messageContentToText,
	orchestrationErrorText,
} from "./conversation-message-mapping.ts";
import type { PersistedMessage } from "./conversation-store-types.ts";
import { buildOrchestrationModelInventory } from "./orchestration-discovery.ts";
import type { OrchestrationTaskRuntime } from "./orchestration-task-runtime.ts";

export interface ConversationOrchestrationContext {
	readonly sessionId: SessionId;
	readonly chatId: ChatId;
	readonly projectId: FolderId;
	readonly worktreeId: WorktreeId | null;
	readonly providerId: ProviderId;
	readonly model: string;
}

export interface ConversationOrchestrationDependencies {
	readonly readThreadPage?: (
		input: OrchestrationReadInput,
	) => Effect.Effect<ReadThreadResult, unknown>;
	readonly runtime: Context.Context<never>;
	readonly tasks?: OrchestrationTaskRuntime;
	readonly automationActor?: import("@zuse/contracts").WorkspaceActor;
	readonly automationActorForCall?: () => Effect.Effect<
		import("@zuse/contracts").WorkspaceActor | undefined,
		unknown
	>;
	readonly automation?: import("../../automation/service.ts").AutomationService["Service"];
	readonly interruptSession?: (
		sessionId: SessionId,
		commandId: string,
	) => Effect.Effect<unknown, unknown>;
	readonly controlSend?: (input: {
		sessionId: SessionId;
		text: string;
		mode: "auto" | "queue" | "steer" | "restart";
		commandId: string;
	}) => Effect.Effect<boolean, unknown>;
	readonly captureDelegation: () => Effect.Effect<DelegationOrigin, unknown>;
	readonly getSettings: () => Effect.Effect<SettingsFile, unknown>;
	/** Resolved model catalog (curated + live); falls back to the bundled snapshot. */
	readonly getModelCatalog: () => Effect.Effect<ResolvedModelCatalog, unknown>;
	readonly createWorktree: (
		projectId: FolderId,
		source?: WorktreeCreateSource,
	) => Effect.Effect<Worktree, unknown>;
	readonly createChat: (input: {
		readonly projectId: FolderId;
		readonly providerId: ProviderId;
		readonly model: string;
		readonly title?: string;
		readonly initialPrompt: string;
		readonly worktreeId: WorktreeId | null;
		readonly originSessionId: SessionId;
		readonly delegation: DelegationOrigin;
	}) => Effect.Effect<
		{ readonly chat: Chat; readonly initialSession: Session },
		unknown
	>;
	readonly createSession: (input: {
		readonly chatId: ChatId;
		readonly providerId: ProviderId;
		readonly model: string;
		readonly title?: string;
		readonly initialPrompt: string;
		readonly originSessionId: SessionId;
		readonly delegation: DelegationOrigin;
		readonly background: true;
		readonly sessionId?: SessionId;
		readonly commandId?: string;
		readonly initialTurnId?: import("@zuse/contracts").AgentTurnId;
		readonly initialMessageId?: import("@zuse/contracts").MessageId;
		readonly runtimeMode?: import("@zuse/contracts").RuntimeMode;
		readonly permissionMode?: import("@zuse/contracts").PermissionMode;
	}) => Effect.Effect<Session, unknown>;
	readonly getChat: (chatId: ChatId) => Effect.Effect<Chat, unknown>;
	readonly getSession: (
		sessionId: SessionId,
	) => Effect.Effect<Session, unknown>;
	readonly waitForSession?: (
		input: SessionWaitInput,
	) => Effect.Effect<SessionWaitResult, unknown>;
	readonly sendToSession: (
		sessionId: SessionId,
		text: string,
		origin: {
			readonly chatId: ChatId;
			readonly sessionId: SessionId;
			readonly providerId: ProviderId;
		},
		wait?: SessionWaitOptions,
		commandId?: string,
	) => Effect.Effect<void | SessionWaitResult, unknown>;
	readonly listMessages: (
		sessionId: SessionId,
	) => Effect.Effect<ReadonlyArray<Message>, unknown>;
	readonly listChats: (
		projectId: FolderId,
		includeArchived: boolean,
	) => Effect.Effect<ReadonlyArray<Chat>, unknown>;
	readonly listSessions: (
		projectId: FolderId,
		includeArchived: boolean,
	) => Effect.Effect<ReadonlyArray<Session>, unknown>;
	/**
	 * Persist one message content block onto the calling session's timeline.
	 * `emit_ui` uses it to append validated `ui_spec` blocks mid-turn.
	 */
	readonly persistMessage: (
		sessionId: SessionId,
		content: MessageContent,
	) => Effect.Effect<PersistedMessage, unknown>;
}

export const makeConversationOrchestration = (
	dependencies: ConversationOrchestrationDependencies,
	context: ConversationOrchestrationContext,
): Effect.Effect<OrchestrationSessionTools> =>
	Effect.gen(function* () {
		const autonomyLevel: AutonomyLevel = "approval-gated";
		const run = Effect.runPromiseWith(dependencies.runtime);
		const providerModelFor = Effect.fn("Orchestration.providerModelFor")(
			function* (input: {
				readonly providerId?: string;
				readonly model?: string;
			}) {
				const settings = yield* dependencies
					.getSettings()
					.pipe(Effect.catchCause(() => Effect.succeed(null)));
				const catalog = yield* dependencies
					.getModelCatalog()
					.pipe(
						Effect.catchCause(() =>
							Effect.succeed(bundledResolvedModelCatalog()),
						),
					);
				const parent = yield* dependencies.getSession(context.sessionId);
				const providerId =
					(input.providerId as ProviderId | undefined) ?? parent.providerId;
				const inventory = buildOrchestrationModelInventory(
					catalog,
					settings,
					providerId,
				);
				const model =
					input.model ??
					(providerId === parent.providerId
						? parent.model
						: inventory.ok
							? (inventory.providers[0]?.defaultModel ??
								defaultModelFor(catalog, providerId))
							: defaultModelFor(catalog, providerId));
				return { providerId, model };
			},
		);
		const sourceForBaseBranch = (
			baseBranch: string | undefined,
		): WorktreeCreateSource | undefined =>
			baseBranch !== undefined
				? { _tag: "branch", branch: baseBranch, remote: null }
				: undefined;
		const createWorktree = (baseBranch?: string) =>
			dependencies.createWorktree(
				context.projectId,
				sourceForBaseBranch(baseBranch),
			);
		const createChat = (input: {
			readonly task: string;
			readonly title?: string;
			readonly worktreeId: WorktreeId | null;
			readonly providerId?: string;
			readonly model?: string;
		}) =>
			Effect.gen(function* () {
				const { providerId, model } = yield* providerModelFor(input);
				return yield* dependencies.captureDelegation().pipe(
					Effect.flatMap((delegation) =>
						dependencies
							.createChat({
								delegation,
								projectId: context.projectId,
								providerId,
								model,
								title: input.title,
								initialPrompt: input.task,
								worktreeId: input.worktreeId,
								originSessionId: context.sessionId,
							})
							.pipe(
								Effect.map((result) => ({
									ok: true as const,
									chatId: result.chat.id as string,
									sessionId: result.initialSession.id as string,
									title: result.chat.title,
									worktreeId:
										result.chat.worktreeId === null
											? null
											: (result.chat.worktreeId as string),
								})),
							),
					),
				);
			});
		const createSession = (input: {
			readonly task: string;
			readonly title?: string;
			readonly chatId: ChatId;
			readonly providerId?: string;
			readonly model?: string;
		}) =>
			Effect.gen(function* () {
				const { providerId, model } = yield* providerModelFor(input);
				return yield* dependencies.captureDelegation().pipe(
					Effect.flatMap((delegation) =>
						dependencies
							.createSession({
								delegation,
								chatId: input.chatId,
								providerId,
								model,
								title: input.title,
								initialPrompt: input.task,
								originSessionId: context.sessionId,
								background: true,
							})
							.pipe(
								Effect.map((session) => ({
									ok: true as const,
									chatId: session.chatId as string,
									sessionId: session.id as string,
									title: session.title,
									worktreeId:
										session.worktreeId === null
											? null
											: (session.worktreeId as string),
								})),
							),
					),
				);
			});
		const masterRouter = Context.getOption(
			dependencies.runtime,
			MasterToolRouter,
		);
		const masterStore = Context.getOption(dependencies.runtime, MasterStore);
		const master = Option.isSome(masterStore)
			? (yield* masterStore.value
					.list()
					.pipe(Effect.catch(() => Effect.succeed([])))).find(
					(master) => master.workspaceId === context.projectId,
				)
			: undefined;
		const privateWorkspaceError = {
			ok: false as const,
			error:
				"Select an explicit managed repository with master_action delegate. The coordinator workspace is private.",
		};
		const automation = dependencies.automation;
		const mutateAutomation = <A, E>(effect: Effect.Effect<A, E>) =>
			run(dependencies.captureDelegation().pipe(Effect.flatMap(() => effect)));
		const automationRouter = Context.getOption(
			dependencies.runtime,
			AutomationAgentRouter,
		);
		const projectAutomation = Option.isSome(automationRouter)
			? (
					input?: import("../../automation/agent-tools.ts").AutomationAgentSave,
				) => {
					const operation = Effect.gen(function* () {
						const actor = dependencies.automationActorForCall
							? yield* dependencies.automationActorForCall()
							: dependencies.automationActor;
						return yield* Effect.promise(() =>
							automationRouter.value.call(context.projectId, input, actor),
						);
					});
					return input ? mutateAutomation(operation) : run(operation);
				}
			: undefined;
		const toolDependencies: OrchestrationToolDeps = {
			projectAutomation,
			master: Option.isSome(masterRouter)
				? (commandJson, readOnly, commandId) =>
						masterRouter.value.call(
							context.sessionId,
							commandJson,
							readOnly,
							// Scoped so IDs chosen by different agents never collide.
							commandId === undefined
								? undefined
								: `mcp:${context.sessionId}:${commandId}`,
						)
				: undefined,

			automation: automation
				? {
						create: (input) =>
							mutateAutomation(
								automation.create(
									{ ...input, sessionId: context.sessionId },
									dependencies.automationActor,
								),
							),
						list: () => run(automation.list(context.sessionId)),
						update: (input) =>
							mutateAutomation(
								automation.update(
									{ ...input, sessionId: context.sessionId },
									dependencies.automationActor,
								),
							),
						remove: (taskId) =>
							mutateAutomation(automation.remove(context.sessionId, taskId)),
						trigger: (taskId, eventId) =>
							mutateAutomation(
								automation.trigger(context.sessionId, taskId, eventId),
							),
						requestSecret: (input) =>
							mutateAutomation(
								automation.requestSecret({
									...input,
									sessionId: context.sessionId,
								}),
							),
						listSecrets: () => run(automation.listSecrets(context.sessionId)),
					}
				: undefined,
			delegateTask: (input) =>
				run(
					Effect.gen(function* () {
						if (master) return privateWorkspaceError;
						const delegation = yield* dependencies.captureDelegation();
						const identity = createHash("sha256")
							.update(
								JSON.stringify([context.sessionId, input.clientRequestId]),
							)
							.digest("hex");
						const sessionId = `s_task_${identity}` as SessionId;
						if (dependencies.tasks) {
							const existing = yield* dependencies.tasks.status(
								context.sessionId,
								sessionId,
							);
							if (existing.ok) {
								const previous = yield* dependencies.getSession(sessionId);
								const messages = yield* dependencies.listMessages(sessionId);
								const expected = input.role
									? `${input.role}\n\n${input.task}`
									: input.task;
								if (
									(input.providerId !== undefined &&
										previous.providerId !== input.providerId) ||
									(input.model !== undefined &&
										previous.model !== input.model) ||
									messageContentToText(
										messages[0]?.content ?? { _tag: "user", text: "" },
									) !== expected
								)
									return yield* Effect.fail({
										reason:
											"clientRequestId was already used for a different task.",
									});
								return existing;
							}
						}
						const parent = yield* dependencies.getSession(context.sessionId);
						const selection = yield* providerModelFor(input);
						const child = yield* dependencies.createSession({
							chatId: context.chatId,
							...selection,
							sessionId,
							commandId: `task-create:${identity}`,
							initialTurnId:
								`turn_task_${identity}` as import("@zuse/contracts").AgentTurnId,
							initialMessageId:
								`message_task_${identity}` as import("@zuse/contracts").MessageId,
							title: input.title,
							initialPrompt: input.role
								? `${input.role}\n\n${input.task}`
								: input.task,
							originSessionId: context.sessionId,
							delegation,
							background: true,
							runtimeMode: parent.runtimeMode,
							permissionMode: parent.permissionMode,
						});
						return {
							ok: true as const,
							taskId: child.id,
							sessionId: child.id,
							status: child.status,
							workState: "working" as const,
						};
					}).pipe(
						Effect.catch((error) =>
							Effect.succeed({
								ok: false as const,
								error: orchestrationErrorText(error),
							}),
						),
					),
				),
			taskStatus: (input) =>
				run(
					(
						dependencies.tasks?.status(context.sessionId, input.taskId) ??
						Effect.fail({ reason: "Task status unavailable." })
					).pipe(
						Effect.catch((error) =>
							Effect.succeed({
								ok: false as const,
								error: orchestrationErrorText(error),
							}),
						),
					),
				),
			taskCancel: (input) =>
				run(
					dependencies.captureDelegation().pipe(
						Effect.flatMap(
							(origin) =>
								dependencies.tasks?.cancel(
									context.sessionId,
									input.taskId,
									origin,
								) ?? Effect.fail({ reason: "Task cancellation unavailable." }),
						),
						Effect.catch((error) =>
							Effect.succeed({
								ok: false as const,
								error: orchestrationErrorText(error),
							}),
						),
					),
				),
			interruptThread: (input) =>
				run(
					Effect.gen(function* () {
						yield* dependencies.captureDelegation();
						const target = yield* dependencies.getSession(
							input.sessionId as SessionId,
						);
						if (target.projectId !== context.projectId)
							return yield* Effect.fail({
								reason: "Target session belongs to a different project.",
							});
						if (!dependencies.interruptSession)
							return yield* Effect.fail({
								reason: "Interruption unavailable.",
							});
						yield* dependencies.interruptSession(
							target.id,
							input.commandId ??
								`orchestration-interrupt:${crypto.randomUUID()}`,
						);
						return { ok: true as const };
					}).pipe(
						Effect.catch((error) =>
							Effect.succeed({
								ok: false as const,
								error: orchestrationErrorText(error),
							}),
						),
					),
				),
			createWorktree: (input) =>
				master
					? Promise.resolve(privateWorkspaceError)
					: run(
							createWorktree(input.baseBranch).pipe(
								Effect.map((worktree) => ({
									ok: true as const,
									worktreeId: worktree.id as string,
									path: worktree.path,
									branch: worktree.branch,
								})),
								Effect.catch((error) =>
									Effect.succeed({
										ok: false as const,
										error: orchestrationErrorText(error),
									}),
								),
							),
						),
			createThread: (input) =>
				run(
					Effect.gen(function* () {
						if (master) return privateWorkspaceError;
						const worktree = yield* createWorktree(input.baseBranch);
						const chat = yield* createChat({
							task: input.task,
							title: input.title,
							worktreeId: worktree.id,
							providerId: input.providerId,
							model: input.model,
						}).pipe(Effect.result);
						if (chat._tag === "Failure") {
							return {
								ok: false as const,
								error: `${orchestrationErrorText(chat.failure)}; orphaned worktreeId: ${worktree.id as string}`,
							};
						}
						return {
							ok: true as const,
							chatId: chat.success.chatId,
							sessionId: chat.success.sessionId,
							title: chat.success.title,
							worktreeId: worktree.id as string,
							path: worktree.path,
							branch: worktree.branch,
						};
					}).pipe(
						Effect.catch((error) =>
							Effect.succeed({
								ok: false as const,
								error: orchestrationErrorText(error),
							}),
						),
					),
				),
			createSession: (input) =>
				run(
					Effect.gen(function* () {
						if (master) return privateWorkspaceError;
						const chatId =
							input.chatId !== undefined
								? (input.chatId as ChatId)
								: context.chatId;
						const chat = yield* dependencies
							.getChat(chatId)
							.pipe(Effect.result);
						if (chat._tag === "Failure") {
							return {
								ok: false as const,
								error: `chatId ${chatId as string} not found`,
							};
						}
						if (
							(chat.success.projectId as string) !==
							(context.projectId as string)
						) {
							return {
								ok: false as const,
								error: `chatId ${chatId as string} does not belong to this project`,
							};
						}
						if (chat.success.archivedAt !== null) {
							return {
								ok: false as const,
								error: `chatId ${chatId as string} is archived`,
							};
						}
						return yield* createSession({
							task: input.task,
							title: input.title,
							chatId,
							providerId: input.providerId,
							model: input.model,
						});
					}).pipe(
						Effect.catch((error) =>
							Effect.succeed({
								ok: false as const,
								error: orchestrationErrorText(error),
							}),
						),
					),
				),
			sendToThread: (input) =>
				run(
					Effect.gen(function* () {
						const sessionId = input.sessionId as SessionId;
						const target = yield* dependencies.getSession(sessionId);
						if (dependencies.tasks)
							yield* dependencies.tasks.assertSendable(sessionId);
						if (target.projectId !== context.projectId)
							return yield* Effect.fail({
								reason: "Target session belongs to a different project.",
							});
						yield* dependencies.captureDelegation();
						if (dependencies.controlSend && input.wait === undefined) {
							const queued = yield* dependencies.controlSend({
								sessionId,
								text: input.text,
								mode: input.mode ?? "auto",
								commandId:
									input.commandId ??
									`orchestration-send:${crypto.randomUUID()}`,
							});
							return {
								ok: true as const,
								queued,
								chatId: target.chatId as string,
							};
						}
						if (
							input.wait !== undefined &&
							input.mode !== undefined &&
							input.mode !== "auto"
						)
							return yield* Effect.fail({
								reason:
									"Use wait_for_thread after queued or interrupted delivery; combined waits currently require auto mode.",
							});
						const waited = yield* dependencies.sendToSession(
							sessionId,
							input.text,
							{
								chatId: context.chatId,
								sessionId: context.sessionId,
								providerId: context.providerId,
							},
							input.wait,
							input.commandId,
						);
						return {
							ok: true as const,
							wait: waited ?? undefined,
							queued: false,
							chatId: target.chatId as string,
						};
					}).pipe(
						Effect.catch((error) =>
							Effect.succeed({
								ok: false as const,
								error: orchestrationErrorText(error),
							}),
						),
					),
				),
			waitForThread: (input) =>
				run(
					Effect.gen(function* () {
						if (dependencies.waitForSession === undefined)
							return {
								ok: false as const,
								error: "Semantic waits are unavailable.",
							};
						const result = yield* dependencies.waitForSession({
							...input,
							sessionId: input.sessionId as SessionId,
							turnId: input.turnId as SessionWaitInput["turnId"],
							attemptId: input.attemptId as SessionWaitInput["attemptId"],
						});
						return { ok: true as const, wait: result };
					}).pipe(
						Effect.catch((error) =>
							Effect.succeed({
								ok: false as const,
								error: orchestrationErrorText(error),
							}),
						),
					),
				),
			readThread: (input) =>
				run(
					Effect.gen(function* () {
						const sessionId = input.sessionId as SessionId;
						const session = yield* dependencies.getSession(sessionId);
						if (session.projectId !== context.projectId)
							return {
								ok: false as const,
								error: "Session belongs to another project.",
							};
						if (dependencies.readThreadPage)
							return yield* dependencies.readThreadPage(input);
						if (
							input.afterMessageId !== undefined ||
							input.messageId !== undefined ||
							input.textOffset !== undefined
						)
							return {
								ok: false as const,
								error: "Incremental reads unavailable.",
							};
						const messages = yield* dependencies.listMessages(sessionId);
						const limit = input.limit ?? 20;
						return {
							ok: true as const,
							status: session.status,
							messages: messages.slice(-limit).map((message) => ({
								role: message.role,
								text: messageContentToText(message.content),
							})),
						};
					}).pipe(
						Effect.catch((error) =>
							Effect.succeed({
								ok: false as const,
								error: orchestrationErrorText(error),
							}),
						),
					),
				),
			listThreads: (input) =>
				run(
					Effect.gen(function* () {
						const includeArchived = input.includeArchived ?? false;
						const chats = yield* dependencies.listChats(
							context.projectId,
							includeArchived,
						);
						const sessions = yield* dependencies.listSessions(
							context.projectId,
							includeArchived,
						);
						const chatsById = new Map(chats.map((chat) => [chat.id, chat]));
						const parents = dependencies.tasks
							? yield* dependencies.tasks.listParents(context.projectId)
							: [];
						const parentBySession = new Map(
							parents.map((parent) => [
								parent.sessionId,
								parent.parentSessionId,
							]),
						);
						const threads = sessions.flatMap((session) => {
							const chat = chatsById.get(session.chatId);
							if (!chat) return [];
							const parentSessionId = parentBySession.get(session.id) ?? null;
							return [
								{
									chatId: chat.id as string,
									sessionId: session.id as string,
									title: session.title,
									worktreeId: session.worktreeId,
									status: session.status,
									parentSessionId,
									chatOriginSessionId: chat.originSessionId,
									spawnedByMe: parentSessionId === context.sessionId,
								},
							];
						});
						return { ok: true as const, threads };
					}).pipe(
						Effect.catch((error) =>
							Effect.succeed({
								ok: false as const,
								error: orchestrationErrorText(error),
							}),
						),
					),
				),
			capabilities: async () => {
				const inventory = await toolDependencies.listModels({});
				if (!inventory.ok) return inventory;
				return {
					ok: true,
					session: await toolDependencies.whoami(),
					providers: inventory.providers,
					tools: ORCHESTRATION_MCP_TOOLS.map((tool) => tool.name),
					limits: {
						readMessages: ORCHESTRATION_READ_LIMIT,
						readTextChars: ORCHESTRATION_TEXT_LIMIT,
					},
					context: { automaticParentHistory: false },
				};
			},
			listModels: (input) =>
				run(
					Effect.gen(function* () {
						const currentSettings = yield* dependencies.getSettings();
						const currentCatalog = yield* dependencies.getModelCatalog();
						return buildOrchestrationModelInventory(
							currentCatalog,
							currentSettings,
							input.providerId,
						);
					}).pipe(
						Effect.catch((error) =>
							Effect.succeed({
								ok: false as const,
								error: orchestrationErrorText(error),
							}),
						),
					),
				),
			whoami: () =>
				run(
					dependencies.getSession(context.sessionId).pipe(
						Effect.map((session) => ({
							sessionId: session.id as string,
							chatId: session.chatId as string,
							projectId: session.projectId as string,
							worktreeId: session.worktreeId,
							providerId: session.providerId,
							model: session.model,
							autonomyLevel,
							permissionMode: session.permissionMode,
							runtimeMode: session.runtimeMode,
						})),
					),
				),
			emitUi: (input) => {
				const validation = prepareGenerativeUiSpec(input.spec);
				if (!validation.ok) {
					return Promise.resolve({
						ok: false as const,
						error: validation.error,
					});
				}
				return run(
					dependencies
						.persistMessage(context.sessionId, {
							_tag: "ui_spec",
							spec: validation.spec,
							version: UI_SPEC_VERSION,
						})
						.pipe(
							Effect.map((persisted) => ({
								ok: true as const,
								messageId: persisted.message.id as string,
							})),
							Effect.catch((error) =>
								Effect.succeed({
									ok: false as const,
									error: orchestrationErrorText(error),
								}),
							),
						),
				);
			},
		};
		return {
			instructions: master
				? masterPrompt(master, context.sessionId)
				: undefined,
			deps: toolDependencies,
			claudeTools: buildOrchestrationTools(toolDependencies),
		};
	});
