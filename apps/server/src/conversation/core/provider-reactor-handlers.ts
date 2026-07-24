import {
	AgentTurnId,
	ComposerInput,
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
	initialTurnId: Schema.optional(Schema.NullOr(AgentTurnId)),
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
const decodeProviderTurnInput = Schema.decodeUnknownEffect(
	Schema.fromJsonString(ComposerInput),
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
	readonly settleTurnFromReactor: (
		sessionId: SessionId,
		turnId: AgentTurnId,
		outcome: "completed" | "interrupted" | "error",
	) => Effect.Effect<void>;
	readonly provider: ProviderServiceShape;
	readonly sessionDomain: SessionDomainApi;
	readonly autoNameChat: (
		chatId: Parameters<ConversationOperations["renameChat"]>[0],
		sessionId: SessionId,
		turnId: string,
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
		settleTurnFromReactor,
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
				initialTurnId: request.initialTurnId ?? undefined,
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
							if (
								request.initialTurnId !== null &&
								request.initialTurnId !== undefined
							) {
								yield* sessionDomain
									.dispatch({
										commandId: `${reactorInput.commandId}:initial-turn-failed`,
										streamId: sessionId,
										command: {
											_tag: "SettleTurn",
											turnId: request.initialTurnId,
											outcome: "error",
											settledAt: Date.now(),
										},
									})
									.pipe(Effect.orDie);
							} else {
								yield* setStatus(sessionId, "error");
							}
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

	const handleProviderTurn: ConversationReactorHandlers["providerTurn"] = (
		reactorInput,
	) =>
		Effect.gen(function* () {
			if (yield* reactorEffects.isCompleted(reactorInput.commandId)) return;
			const sessionId = SessionId.make(reactorInput.streamId);
			const input = yield* decodeProviderTurnInput(
				reactorInput.command.providerInputJson,
			).pipe(Effect.orDie);
			const sent = yield* provider
				.send(
					sessionId,
					AgentTurnId.make(reactorInput.command.turnId),
					input.text,
					input.attachments,
					input.fileRefs,
					input.skillRefs,
				)
				.pipe(Effect.exit);
			if (sent._tag === "Failure") {
				const session = yield* lookupSession(sessionId).pipe(Effect.orDie);
				const restarted = yield* openProviderSession(session, {
					sendAfterOpen: {
						turnId: AgentTurnId.make(reactorInput.command.turnId),
						text: input.text,
						attachments: input.attachments,
						fileRefs: input.fileRefs,
						skillRefs: input.skillRefs,
					},
				}).pipe(Effect.exit);
				if (restarted._tag === "Success") {
					yield* reactorEffects.complete(reactorInput.commandId);
					return;
				}
				yield* sessionDomain
					.dispatch({
						commandId: `${reactorInput.commandId}:failed`,
						streamId: sessionId,
						command: {
							_tag: "SettleTurn",
							turnId: reactorInput.command.turnId,
							outcome: "error",
							settledAt: Date.now(),
						},
					})
					.pipe(Effect.orDie);
				return yield* Effect.die(
					new Error("Provider turn could not be started after durable intent"),
				);
			}
			yield* reactorEffects.complete(reactorInput.commandId);
		});

	const handleProviderInterrupt: ConversationReactorHandlers["providerInterrupt"] =
		(reactorInput) =>
			Effect.gen(function* () {
				if (yield* reactorEffects.isCompleted(reactorInput.commandId)) return;
				const sessionId = SessionId.make(reactorInput.streamId);
				const turnId = AgentTurnId.make(reactorInput.command.turnId);
				const interrupted = yield* provider
					.interrupt(sessionId, turnId)
					.pipe(Effect.timeout("5 seconds"), Effect.exit);
				if (interrupted._tag === "Success") {
					yield* sessionDomain
						.dispatch({
							commandId: `${reactorInput.commandId}:acknowledged`,
							streamId: sessionId,
							command: {
								_tag: "AcknowledgeTurnInterrupt",
								turnId,
								acknowledgedAt: Date.now(),
							},
						})
						.pipe(Effect.orDie);
					yield* settleTurnFromReactor(sessionId, turnId, "interrupted");
					yield* reactorEffects.complete(reactorInput.commandId);
					return;
				}
				yield* sessionDomain
					.dispatch({
						commandId: `${reactorInput.commandId}:failed`,
						streamId: sessionId,
						command: {
							_tag: "FailTurnInterrupt",
							turnId,
							reason: "Provider did not acknowledge cancellation",
							failedAt: Date.now(),
						},
					})
					.pipe(Effect.orDie);
				yield* sessionDomain
					.dispatch({
						commandId: `${reactorInput.commandId}:settled`,
						streamId: sessionId,
						command: {
							_tag: "SettleTurn",
							turnId,
							outcome: "interrupted",
							settledAt: Date.now(),
						},
					})
					.pipe(Effect.orDie);
				yield* provider.close(sessionId).pipe(Effect.ignore);
				yield* reactorEffects.complete(reactorInput.commandId);
			});

	const handleScheduledSuccessor: ConversationReactorHandlers["scheduledSuccessor"] =
		(reactorInput) =>
			Effect.gen(function* () {
				if (yield* reactorEffects.isCompleted(reactorInput.commandId)) return;
				const sessionId = SessionId.make(reactorInput.streamId);
				const input = yield* decodeProviderTurnInput(
					reactorInput.command.inputJson,
				).pipe(Effect.orDie);
				const hasRich =
					input.attachments.length > 0 ||
					input.fileRefs.length > 0 ||
					input.skillRefs.length > 0 ||
					(input.annotations?.length ?? 0) > 0;
				const content = hasRich
					? {
							_tag: "user_rich" as const,
							text: input.text,
							attachments: input.attachments,
							fileRefs: input.fileRefs,
							skillRefs: input.skillRefs,
							annotations: input.annotations ?? [],
							goal: false,
						}
					: { _tag: "user" as const, text: input.text, goal: false };
				yield* sessionDomain
					.dispatch({
						commandId: `${reactorInput.commandId}:submit`,
						streamId: sessionId,
						command: {
							_tag: "SubmitTurn",
							turnId: reactorInput.command.turnId,
							messageId: `queued_${reactorInput.command.queueId}`,
							role: "user",
							kind: content._tag,
							contentJson: JSON.stringify(content),
							parentItemId: null,
							providerInputJson: reactorInput.command.inputJson,
							createdAt: Date.now(),
						},
					})
					.pipe(Effect.orDie);
				yield* reactorEffects.complete(reactorInput.commandId);
			});

	const handleAutoName: ConversationReactorHandlers["autoName"] = (input) =>
		Effect.gen(function* () {
			const sessionId = SessionId.make(input.streamId);
			const session = yield* lookupSession(sessionId).pipe(Effect.orDie);
			yield* autoNameChat(
				session.chatId,
				sessionId,
				input.command.turnId,
				input.commandId,
			);
		});

	return {
		handleProviderStart,
		handleProviderStop,
		handleProviderTurn,
		handleProviderInterrupt,
		handleScheduledSuccessor,
		handleAutoName,
	};
};
