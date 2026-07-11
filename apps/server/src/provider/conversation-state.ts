import {
	type AgentDefinition,
	DEFAULT_RUNTIME_MODE,
	type FolderId,
	type RuntimeMode,
	type SessionId,
} from "@zuse/contracts";
import { Context, Effect, Layer } from "effect";

/**
 * Sub-agents configuration cached per session: the resolved `agents` map plus
 * whether sub-agents are enabled. Captured on `createSession` / first
 * `lookupSession` so a resumed or restarted SDK session sees the same shape the
 * original creation chose.
 */
export interface SessionAgentsConfig {
	readonly agents: Readonly<Record<string, AgentDefinition>>;
	readonly enableSubagents: boolean;
}

/**
 * In-memory, per-session runtime caches shared across the conversation
 * services. These mirror durable session state so hot paths (the driver's
 * runtime-mode getter handed to `provider.start`, the streaming pump's
 * active-turn check) resolve synchronously without a DB round-trip.
 *
 * Methods are intentionally synchronous: the provider-start callbacks that read
 * `runtimeMode` / `hasActiveTurn` are plain functions, so this substrate must
 * expose plain accessors rather than Effect-returning ones.
 *
 * Responsibility: own the process-lifetime caches (project id, runtime mode,
 * permission mode, sub-agents config, active turn id) keyed by session.
 * NOT responsible for: persistence, command dispatch, or reactor execution —
 * those own their durable state elsewhere.
 */
export interface ConversationStateApi {
	readonly projectId: (sessionId: SessionId) => FolderId | undefined;
	readonly setProjectId: (sessionId: SessionId, folderId: FolderId) => void;
	/** Live runtime mode, defaulting to {@link DEFAULT_RUNTIME_MODE}. */
	readonly runtimeMode: (sessionId: SessionId) => RuntimeMode;
	readonly setRuntimeMode: (sessionId: SessionId, mode: RuntimeMode) => void;
	readonly agents: (sessionId: SessionId) => SessionAgentsConfig | undefined;
	readonly hasAgents: (sessionId: SessionId) => boolean;
	readonly setAgents: (
		sessionId: SessionId,
		value: SessionAgentsConfig,
	) => void;
	readonly activeTurn: (sessionId: SessionId) => string | undefined;
	readonly setActiveTurn: (sessionId: SessionId, turnId: string) => void;
	readonly clearActiveTurn: (sessionId: SessionId) => void;
	readonly hasActiveTurn: (sessionId: SessionId) => boolean;
	/** Release every process-lifetime entry after a durable session deletion. */
	readonly clearSession: (sessionId: SessionId) => void;
}

export class ConversationState extends Context.Service<
	ConversationState,
	ConversationStateApi
>()("zuse/server/Conversation/State") {
	static readonly layer = Layer.effect(
		ConversationState,
		Effect.sync(() => {
			const projectIdBySession = new Map<SessionId, FolderId>();
			const runtimeModeBySession = new Map<SessionId, RuntimeMode>();
			const agentsBySession = new Map<SessionId, SessionAgentsConfig>();
			const turnIdsBySession = new Map<SessionId, string>();
			return {
				projectId: (sessionId) => projectIdBySession.get(sessionId),
				setProjectId: (sessionId, folderId) => {
					projectIdBySession.set(sessionId, folderId);
				},
				runtimeMode: (sessionId) =>
					runtimeModeBySession.get(sessionId) ?? DEFAULT_RUNTIME_MODE,
				setRuntimeMode: (sessionId, mode) => {
					runtimeModeBySession.set(sessionId, mode);
				},
				agents: (sessionId) => agentsBySession.get(sessionId),
				hasAgents: (sessionId) => agentsBySession.has(sessionId),
				setAgents: (sessionId, value) => {
					agentsBySession.set(sessionId, value);
				},
				activeTurn: (sessionId) => turnIdsBySession.get(sessionId),
				setActiveTurn: (sessionId, turnId) => {
					turnIdsBySession.set(sessionId, turnId);
				},
				clearActiveTurn: (sessionId) => {
					turnIdsBySession.delete(sessionId);
				},
				hasActiveTurn: (sessionId) => turnIdsBySession.has(sessionId),
				clearSession: (sessionId) => {
					projectIdBySession.delete(sessionId);
					runtimeModeBySession.delete(sessionId);
					agentsBySession.delete(sessionId);
					turnIdsBySession.delete(sessionId);
				},
			} satisfies ConversationStateApi;
		}),
	);
}
