import {
	type MessageContent,
	type Session,
	SessionId,
	SessionStartError,
} from "@zuse/contracts";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import { Effect, Schema } from "effect";
import type { makeReactorEffectJournal } from "../../provider/reactor-effect-journal.ts";
import type { ProviderServiceShape } from "../../provider/services/provider-service.ts";
import type { ConversationOperations } from "../services/conversation-services.ts";
import type { ConversationReactorHandlers } from "./conversation-reactors.ts";
import type { PersistedMessage } from "./conversation-store-types.ts";
import type { OpenProviderSessionOptions } from "./provider-session-runtime.ts";

const ProviderStartRequest = Schema.Struct({
	initialPrompt: Schema.NullOr(Schema.String),
	modelOptionsJson: Schema.NullOr(Schema.String),
	enableSubagents: Schema.Boolean,
	forkFromResume: Schema.Boolean,
	background: Schema.Boolean,
	postBootStatus: Schema.Literals(["idle", "running"]),
});
const decodeProviderStartRequest = Schema.decodeUnknownEffect(
	Schema.fromJsonString(ProviderStartRequest),
);
const decodeProviderModelOptions = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

export interface ProviderReactorHandlersOptions {
	readonly reactorEffects: ReturnType<typeof makeReactorEffectJournal>;
	readonly getSession: ConversationOperations["getSession"];
	readonly openProviderSession: (
		session: Session,
		options?: OpenProviderSessionOptions,
	) => Effect.Effect<void, SessionStartError>;
	readonly persistMessage: (
		sessionId: SessionId,
		content: MessageContent,
	) => Effect.Effect<PersistedMessage>;
	readonly ndjsonAppend: (
		sessionId: SessionId,
		persisted: PersistedMessage,
	) => Effect.Effect<void>;
	readonly setStatus: (
		sessionId: SessionId,
		status: "error",
	) => Effect.Effect<void>;
	readonly provider: ProviderServiceShape;
	readonly sessionDomain: SessionDomainApi;
	readonly autoNameChat: (
		chatId: Parameters<ConversationOperations["renameChat"]>[0],
		sessionId: SessionId,
		commandId: string,
	) => Effect.Effect<void>;
}

export const makeProviderReactorHandlers = (
	options: ProviderReactorHandlersOptions,
) => {
	const {
		reactorEffects,
		getSession: lookupSession,
		openProviderSession,
		persistMessage,
		ndjsonAppend,
		setStatus,
		provider,
		sessionDomain,
		autoNameChat,
	} = options;
	const handleProviderStart: ConversationReactorHandlers["providerStart"] = (
		reactorInput,
	) =>
		Effect.gen(function* () {
			if (yield* reactorEffects.isCompleted(reactorInput.commandId)) return;

			const sessionId = SessionId.make(reactorInput.streamId);
			const session = yield* lookupSession(sessionId).pipe(
				Effect.catch(() => Effect.succeed(null)),
			);
			if (session === null) return;
			const request = yield* decodeProviderStartRequest(
				reactorInput.command.providerStartJson,
			).pipe(
				Effect.mapError(
					(cause) =>
						new SessionStartError({
							providerId: session.providerId,
							reason: `Invalid provider start request: ${String(cause)}`,
						}),
				),
			);
			const modelOptions =
				request.modelOptionsJson === null
					? undefined
					: yield* decodeProviderModelOptions(request.modelOptionsJson).pipe(
							Effect.mapError(
								(cause) =>
									new SessionStartError({
										providerId: session.providerId,
										reason: `Invalid provider model options: ${String(cause)}`,
									}),
							),
						);
			const start = openProviderSession(session, {
				initialPrompt: request.initialPrompt ?? undefined,
				modelOptions,
				enableSubagents: request.enableSubagents,
				forkFromResume: request.forkFromResume,
				postBootStatus: request.postBootStatus,
			});
			if (request.background) {
				yield* start.pipe(
					Effect.catch((error) =>
						Effect.gen(function* () {
							yield* Effect.logWarning(
								`[ConversationServices] provider.start failed for session ${sessionId} (${session.providerId}): ${error.reason}`,
							);
							const persistedError = yield* persistMessage(sessionId, {
								_tag: "error",
								message: error.reason,
							});
							yield* ndjsonAppend(sessionId, persistedError);
							yield* setStatus(sessionId, "error");
						}),
					),
				);
			} else {
				yield* start;
			}
			yield* reactorEffects.complete(reactorInput.commandId);
		});

	const handleProviderStop: ConversationReactorHandlers["providerStop"] = (
		reactorInput,
	) =>
		Effect.gen(function* () {
			if (yield* reactorEffects.isCompleted(reactorInput.commandId)) return;
			const sessionId = SessionId.make(reactorInput.streamId);
			yield* provider.close(sessionId).pipe(Effect.catch(() => Effect.void));
			yield* sessionDomain
				.dispatch({
					commandId: `${reactorInput.commandId}:detach`,
					streamId: sessionId,
					command: {
						_tag: "DetachProvider",
						detachedAt: reactorInput.command.requestedAt,
					},
				})
				.pipe(Effect.orDie);
			yield* reactorEffects.complete(reactorInput.commandId);
		});

	const handleAutoName: ConversationReactorHandlers["autoName"] = (input) =>
		Effect.gen(function* () {
			const sessionId = SessionId.make(input.streamId);
			const session = yield* lookupSession(sessionId).pipe(Effect.orDie);
			yield* autoNameChat(session.chatId, sessionId, input.commandId);
		});

	return { handleProviderStart, handleProviderStop, handleAutoName };
};
