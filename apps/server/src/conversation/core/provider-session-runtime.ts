import {
	type AttachmentRef,
	type ProviderId,
	type Session,
	type SessionId,
	SessionStartError,
	type WorktreeId,
} from "@zuse/contracts";
import type { WorktreeServiceShape } from "@zuse/git/worktree-service";
import { Effect } from "effect";
import type { ConfigStoreServiceShape } from "../../config-store/services/config-store-service.ts";
import type { ProviderServiceShape } from "../../provider/services/provider-service.ts";
import type {
	ConversationOperations,
	CreateChatInput,
	CreateSessionInput,
} from "../services/conversation-services.ts";
import { formatProviderFailure } from "./conversation-input.ts";
import { makeConversationOrchestration } from "./conversation-orchestration.ts";
import type { ConversationStateApi } from "./conversation-state.ts";

export interface OpenProviderSessionOptions {
	readonly initialPrompt?: string;
	readonly modelOptions?: Readonly<Record<string, string>>;
	readonly enableSubagents?: boolean;
	readonly forkFromResume?: boolean;
	readonly postBootStatus?: Session["status"];
	readonly sendAfterOpen?: {
		readonly text: string;
		readonly attachments: ReadonlyArray<AttachmentRef>;
	};
}

export interface ProviderSessionRuntimeOptions {
	readonly state: ConversationStateApi;
	readonly agentsFor: (
		sessionId: SessionId,
	) => ReturnType<ConversationStateApi["agents"]>;
	readonly cwdForWorktree: (
		worktreeId: WorktreeId | null,
	) => Effect.Effect<string | undefined>;
	readonly runtime: Parameters<
		typeof makeConversationOrchestration
	>[0]["runtime"];
	readonly configStore: ConfigStoreServiceShape;
	readonly worktrees: WorktreeServiceShape;
	readonly createChat: (
		input: CreateChatInput,
	) => ReturnType<ConversationOperations["createChat"]>;
	readonly createSession: (
		input: CreateSessionInput,
	) => ReturnType<ConversationOperations["createSession"]>;
	readonly getChat: ConversationOperations["getChat"];
	readonly getSession: ConversationOperations["getSession"];
	readonly sendMessage: ConversationOperations["sendMessage"];
	readonly listMessages: ConversationOperations["listMessages"];
	readonly listChats: ConversationOperations["listChats"];
	readonly listSessions: ConversationOperations["listSessions"];
	readonly provider: ProviderServiceShape;
	readonly attachProvider: (
		sessionId: SessionId,
		providerId: ProviderId,
	) => Effect.Effect<void>;
	readonly setStatus: (
		sessionId: SessionId,
		status: Session["status"],
	) => Effect.Effect<void>;
	readonly startSubscription: (sessionId: SessionId) => Effect.Effect<void>;
}

export const makeProviderSessionRuntime = (
	options: ProviderSessionRuntimeOptions,
) => {
	const {
		state,
		agentsFor,
		cwdForWorktree,
		runtime,
		configStore,
		worktrees,
		createChat,
		createSession,
		getChat: lookupChat,
		getSession: lookupSession,
		sendMessage,
		listMessages,
		listChats,
		listSessions,
		provider,
		attachProvider,
		setStatus,
		startSubscription,
	} = options;
	const openProviderSession = (
		session: Session,
		options: OpenProviderSessionOptions = {},
	): Effect.Effect<void, SessionStartError> =>
		Effect.gen(function* () {
			state.setRuntimeMode(session.id, session.runtimeMode);
			const subagents = agentsFor(session.id);
			const cwdOverride = yield* cwdForWorktree(session.worktreeId);
			const orchestrationTools = yield* makeConversationOrchestration(
				{
					runtime,
					getSettings: configStore.getSettings,
					createWorktree: (projectId, source) =>
						worktrees.create(projectId, source),
					createChat: (input) => createChat(input),
					createSession: (input) => createSession(input),
					getChat: lookupChat,
					getSession: lookupSession,
					sendToSession: (sessionId, text, origin) =>
						sendMessage(
							sessionId,
							text,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							origin,
						),
					listMessages,
					listChats,
					listSessions,
				},
				{
					sessionId: session.id,
					chatId: session.chatId,
					projectId: session.projectId,
					worktreeId: session.worktreeId,
					providerId: session.providerId,
					model: session.model,
				},
			);
			yield* provider
				.start(
					{
						folderId: session.projectId,
						providerId: session.providerId,
						mode: "sdk",
						sessionId: session.id,
						initialPrompt: options.initialPrompt,
						model: session.model,
						agents: subagents?.agents,
						enableSubagents:
							options.enableSubagents ?? subagents?.enableSubagents,
						cwdOverride,
						permissionMode: session.permissionMode,
						modelOptions: options.modelOptions,
						toolSearch: session.toolSearch,
						forkFromResume: options.forkFromResume,
					},
					session.cursor,
					() => state.runtimeMode(session.id),
					orchestrationTools,
				)
				.pipe(
					Effect.mapError((error) =>
						error._tag === "ProviderNotAvailableError"
							? new SessionStartError({
									providerId: session.providerId,
									reason: error.reason,
								})
							: error._tag === "AgentSessionStartError"
								? new SessionStartError({
										providerId: error.providerId,
										reason: error.reason,
									})
								: new SessionStartError({
										providerId: session.providerId,
										reason: formatProviderFailure(error),
									}),
					),
				);
			yield* attachProvider(session.id, session.providerId);
			if (options.postBootStatus !== undefined) {
				yield* setStatus(session.id, options.postBootStatus);
			}
			yield* startSubscription(session.id);
			if (options.sendAfterOpen !== undefined) {
				yield* provider
					.send(
						session.id,
						options.sendAfterOpen.text,
						options.sendAfterOpen.attachments,
					)
					.pipe(
						Effect.catchTag("AgentSessionNotFoundError", () =>
							Effect.fail(
								new SessionStartError({
									providerId: session.providerId,
									reason: "Provider session disappeared after start.",
								}),
							),
						),
					);
			}
		});

	return { openProviderSession };
};
