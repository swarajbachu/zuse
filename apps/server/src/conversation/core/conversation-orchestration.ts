/** Builds the session-bound orchestration tool surface. */

import {
	buildLinearTools,
	type LinearToolDeps,
} from "@zuse/agents/drivers/linear-tools";
import {
	buildOrchestrationTools,
	type OrchestrationSessionTools,
	type OrchestrationToolDeps,
} from "@zuse/agents/drivers/orchestration-tools";
import {
	type AutonomyLevel,
	type Chat,
	type ChatId,
	defaultModelFor,
	type FolderId,
	type Message,
	MODELS_BY_PROVIDER,
	type ProviderId,
	type Session,
	type SessionId,
	type SettingsFile,
	visibleModelsForProvider,
	type Worktree,
	type WorktreeCreateSource,
	type WorktreeId,
} from "@zuse/contracts";
import { type Context, Effect } from "effect";
import {
	messageContentToText,
	orchestrationErrorText,
} from "./conversation-message-mapping.ts";

export interface ConversationOrchestrationContext {
	readonly sessionId: SessionId;
	readonly chatId: ChatId;
	readonly projectId: FolderId;
	readonly worktreeId: WorktreeId | null;
	readonly providerId: ProviderId;
	readonly model: string;
}

export interface ConversationOrchestrationDependencies {
	readonly runtime: Context.Context<never>;
	readonly getSettings: () => Effect.Effect<SettingsFile, unknown>;
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
		readonly background: true;
	}) => Effect.Effect<Session, unknown>;
	readonly getChat: (chatId: ChatId) => Effect.Effect<Chat, unknown>;
	readonly getSession: (
		sessionId: SessionId,
	) => Effect.Effect<Session, unknown>;
	readonly sendToSession: (
		sessionId: SessionId,
		text: string,
		origin: {
			readonly chatId: ChatId;
			readonly sessionId: SessionId;
			readonly providerId: ProviderId;
		},
	) => Effect.Effect<void, unknown>;
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
	readonly linearTools?: LinearToolDeps;
}

export const makeConversationOrchestration = (
	dependencies: ConversationOrchestrationDependencies,
	context: ConversationOrchestrationContext,
): Effect.Effect<OrchestrationSessionTools> =>
	Effect.gen(function* () {
		const settings = yield* dependencies
			.getSettings()
			.pipe(Effect.catchCause(() => Effect.succeed(null)));
		const autonomyLevel: AutonomyLevel = "approval-gated";
		const run = Effect.runPromiseWith(dependencies.runtime);
		const providerModelFor = (input: {
			readonly providerId?: string;
			readonly model?: string;
		}): { readonly providerId: ProviderId; readonly model: string } => {
			const providerId =
				(input.providerId as ProviderId | undefined) ?? context.providerId;
			const model =
				input.model ??
				(providerId === context.providerId
					? context.model
					: (settings?.defaultModelByProvider[providerId] ??
						defaultModelFor(providerId)));
			return { providerId, model };
		};
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
		}) => {
			const { providerId, model } = providerModelFor(input);
			return dependencies
				.createChat({
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
				);
		};
		const createSession = (input: {
			readonly task: string;
			readonly title?: string;
			readonly chatId: ChatId;
			readonly providerId?: string;
			readonly model?: string;
		}) => {
			const { providerId, model } = providerModelFor(input);
			return dependencies
				.createSession({
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
				);
		};
		const toolDependencies: OrchestrationToolDeps = {
			createWorktree: (input) =>
				run(
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
						yield* dependencies.sendToSession(sessionId, input.text, {
							chatId: context.chatId,
							sessionId: context.sessionId,
							providerId: context.providerId,
						});
						return {
							ok: true as const,
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
			readThread: (input) =>
				run(
					Effect.gen(function* () {
						const sessionId = input.sessionId as SessionId;
						const session = yield* dependencies.getSession(sessionId);
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
						const statusBySession = new Map(
							sessions.map((session) => [
								session.id as string,
								session.status as string,
							]),
						);
						const threads = chats.map((chat) => ({
							chatId: chat.id as string,
							sessionId: (chat.activeSessionId ?? "") as string,
							title: chat.title,
							worktreeId:
								chat.worktreeId === null ? null : (chat.worktreeId as string),
							status:
								chat.activeSessionId !== null
									? (statusBySession.get(chat.activeSessionId as string) ??
										"unknown")
									: "unknown",
							spawnedByMe: chat.originSessionId === context.sessionId,
						}));
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
			listModels: (input) =>
				Promise.resolve().then(() => {
					const allProviderIds = Object.keys(
						MODELS_BY_PROVIDER,
					) as ProviderId[];
					const providerIds =
						input.providerId !== undefined
							? allProviderIds.includes(input.providerId as ProviderId)
								? [input.providerId as ProviderId]
								: []
							: allProviderIds;
					if (input.providerId !== undefined && providerIds.length === 0) {
						return {
							ok: false as const,
							error: `Unknown providerId: ${input.providerId}`,
						};
					}
					const providers = providerIds.map((providerId) => {
						const defaultModel =
							settings?.defaultModelByProvider[providerId] ??
							defaultModelFor(providerId);
						const models = visibleModelsForProvider(
							providerId,
							settings?.modelEnabledByProvider,
							{ includeModelId: defaultModel },
						).map((model) => ({
							id: model.id,
							label: model.label,
							defaultModel: model.id === defaultModel,
						}));
						return { providerId, defaultModel, models };
					});
					return { ok: true as const, providers };
				}),
			whoami: () =>
				Promise.resolve({
					sessionId: context.sessionId as string,
					chatId: context.chatId as string,
					projectId: context.projectId as string,
					worktreeId:
						context.worktreeId === null ? null : (context.worktreeId as string),
					providerId: context.providerId as string,
					model: context.model,
					autonomyLevel,
				}),
		};
		return {
			deps: toolDependencies,
			claudeTools: buildOrchestrationTools(toolDependencies),
			...(dependencies.linearTools === undefined
				? {}
				: {
						linearTools: {
							deps: dependencies.linearTools,
							claudeTools: buildLinearTools(dependencies.linearTools),
						},
					}),
		};
	});
