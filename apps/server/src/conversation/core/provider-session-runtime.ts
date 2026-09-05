import type { LinearToolDeps } from "@zuse/agents/drivers/linear-tools";
import {
	type AgentTurnId,
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
import type { ModelCatalogServiceShape } from "../../model-catalog/services/model-catalog-service.ts";
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
	readonly initialTurnId?: AgentTurnId;
	readonly modelOptions?: Readonly<Record<string, string>>;
	readonly enableSubagents?: boolean;
	readonly forkFromResume?: boolean;
	readonly postBootStatus?: Session["status"];
	readonly sendAfterOpen?: {
		readonly turnId: AgentTurnId;
		readonly text: string;
		readonly attachments: ReadonlyArray<AttachmentRef>;
		readonly fileRefs?: ReadonlyArray<import("@zuse/contracts").FileRef>;
		readonly skillRefs?: ReadonlyArray<import("@zuse/contracts").SkillRef>;
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
	readonly modelCatalog: ModelCatalogServiceShape;
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
	readonly linearTools?: LinearToolDeps;
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
		modelCatalog,
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
		linearTools,
	} = options;
	const openProviderSession = (
		session: Session,
		options: OpenProviderSessionOptions = {},
	): Effect.Effect<boolean, SessionStartError> =>
		Effect.gen(function* () {
			// Resolve configuration again at the execution edge. Reactor handlers may
			// have captured this row before a provider/model switch committed.
			const configured = yield* lookupSession(session.id).pipe(
				Effect.map(
					(current) =>
						current.providerId === session.providerId &&
						current.model === session.model,
				),
				Effect.catch(() => Effect.succeed(false)),
			);
			if (!configured) return false;
			state.setRuntimeMode(session.id, session.runtimeMode);
			const subagents = agentsFor(session.id);
			const cwdOverride = yield* cwdForWorktree(session.worktreeId);
			const orchestrationTools = yield* makeConversationOrchestration(
				{
					runtime,
					getSettings: configStore.getSettings,
					getModelCatalog: modelCatalog.current,
					createWorktree: (projectId, source) =>
						worktrees.create(projectId, source),
					createChat: (input) => createChat(input),
					createSession: (input) => createSession(input),
					getChat: lookupChat,
					getSession: lookupSession,
					sendToSession: (sessionId, text, origin) =>
						sendMessage(
							`orchestration-send:${sessionId}:${crypto.randomUUID()}`,
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
					linearTools,
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
			const started = yield* provider
				.start(
					{
						folderId: session.projectId,
						providerId: session.providerId,
						mode: "sdk",
						sessionId: session.id,
						initialPrompt: options.initialPrompt,
						initialTurnId: options.initialTurnId,
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
					session.providerEventCursor ?? null,
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
			if (started.superseded === true) return false;
			const publishable = yield* lookupSession(session.id).pipe(
				Effect.map(
					(current) =>
						current.providerId === session.providerId &&
						current.model === session.model,
				),
				Effect.catch(() => Effect.succeed(false)),
			);
			if (!publishable) {
				// The durable provider switch owns teardown. Closing by session id here
				// could race with a newer startup and accidentally close its handle.
				return false;
			}
			const publish = (effect: Effect.Effect<void, SessionStartError>) =>
				started.generation === undefined
					? effect.pipe(Effect.as(true))
					: provider.guardCurrent(session.id, started.generation, effect);
			// Keep every externally visible handoff behind the lease. Guarding only
			// `start()` still lets a stopped generation attach or publish `running`.
			if (!(yield* publish(attachProvider(session.id, session.providerId))))
				return false;
			if (!(yield* publish(startSubscription(session.id)))) return false;
			if (
				options.sendAfterOpen !== undefined &&
				!(yield* publish(
					provider
						.send(
							session.id,
							options.sendAfterOpen.turnId,
							options.sendAfterOpen.text,
							options.sendAfterOpen.attachments,
							options.sendAfterOpen.fileRefs,
							options.sendAfterOpen.skillRefs,
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
						),
				))
			)
				return false;
			if (
				options.postBootStatus !== undefined &&
				!(yield* publish(setStatus(session.id, options.postBootStatus)))
			)
				return false;
			return true;
		});

	/** The only external startup seam: callers identify durable work, while this
	 * module resolves the latest provider configuration and owns the handoff. */
	const ensureForTurn = (
		sessionId: SessionId,
		options: OpenProviderSessionOptions = {},
	): Effect.Effect<boolean, SessionStartError> =>
		lookupSession(sessionId).pipe(
			Effect.mapError(
				() =>
					new SessionStartError({
						providerId: "codex",
						reason: "Session disappeared before provider startup.",
					}),
			),
			Effect.flatMap((session) => openProviderSession(session, options)),
		);

	return { ensureForTurn };
};
