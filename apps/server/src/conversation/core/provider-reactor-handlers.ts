import {
	AgentTurnId,
	type MessageContent,
	SessionId,
	SessionStartError,
} from "@zuse/contracts";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import { Effect } from "effect";
import type { makeReactorEffectJournal } from "../../provider/reactor-effect-journal.ts";
import type { ProviderServiceShape } from "../../provider/services/provider-service.ts";
import type { ConversationOperations } from "../services/conversation-services.ts";
import type { ConversationReactorHandlers } from "./conversation-reactors.ts";
import type { PersistedMessage } from "./conversation-store-types.ts";
import type { OpenProviderSessionOptions } from "./provider-session-runtime.ts";
import {
	decodeProviderModelOptions,
	decodeProviderStartRequest,
	decodeProviderTurnInput,
} from "./provider-turn-request.ts";

const isAuthenticationRequired = (reason: string): boolean =>
	/\bauthentication required\b/i.test(reason);

export interface ProviderReactorHandlersOptions {
	readonly reactorEffects: ReturnType<typeof makeReactorEffectJournal>;
	readonly getSession: ConversationOperations["getSession"];
	readonly ensureForTurn: (
		sessionId: SessionId,
		options?: OpenProviderSessionOptions,
	) => Effect.Effect<boolean, SessionStartError>;
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
		status: "idle" | "running" | "error",
	) => Effect.Effect<void>;
	readonly resolveActiveTurn: (
		sessionId: SessionId,
	) => Effect.Effect<AgentTurnId | undefined>;
	readonly getProviderStartJson: (
		sessionId: SessionId,
	) => Effect.Effect<string | null>;
	readonly settleTurnFromReactor: (
		sessionId: SessionId,
		turnId: AgentTurnId,
		outcome: "completed" | "interrupted" | "error",
	) => Effect.Effect<void>;
	readonly rememberActiveTurn: (
		sessionId: SessionId,
		turnId: AgentTurnId,
	) => void;
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
		ensureForTurn,
		persistMessage,
		ndjsonAppend,
		setStatus,
		resolveActiveTurn,
		getProviderStartJson,
		settleTurnFromReactor,
		rememberActiveTurn,
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
			// Compatibility guard for durable eager-start effects written by older
			// builds. Empty sessions are dormant: acknowledge the legacy effect and
			// repair their old booting projection without spawning a provider.
			if ((yield* resolveActiveTurn(sessionId)) === undefined) {
				if (session.status === "booting") yield* setStatus(sessionId, "idle");
				yield* reactorEffects.complete(reactorInput.commandId);
				return;
			}
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
			const start = ensureForTurn(sessionId, {
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
								yield* settleTurnFromReactor(
									sessionId,
									request.initialTurnId,
									"error",
								);
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
			const providerStartJson =
				reactorInput.command.providerStartJson ??
				(yield* getProviderStartJson(sessionId));
			const startupRequest =
				providerStartJson === null
					? null
					: yield* decodeProviderStartRequest(providerStartJson).pipe(
							Effect.orDie,
						);
			const startupModelOptions =
				startupRequest?.modelOptionsJson == null
					? undefined
					: yield* decodeProviderModelOptions(
							startupRequest.modelOptionsJson,
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
			if (sent._tag === "Success") {
				yield* setStatus(sessionId, "running");
			}
			if (sent._tag === "Failure") {
				const restarted = yield* ensureForTurn(sessionId, {
					modelOptions: startupModelOptions,
					enableSubagents: startupRequest?.enableSubagents,
					forkFromResume: startupRequest?.forkFromResume,
					postBootStatus: "running",
					sendAfterOpen: {
						turnId: AgentTurnId.make(reactorInput.command.turnId),
						text: input.text,
						attachments: input.attachments,
						fileRefs: input.fileRefs,
						skillRefs: input.skillRefs,
					},
				}).pipe(
					Effect.match({
						onFailure: (error) => ({ ok: false as const, error }),
						onSuccess: (started) => ({ ok: started, error: null }),
					}),
				);
				if (restarted.ok) {
					yield* reactorEffects.complete(reactorInput.commandId);
					return;
				}
				if (restarted.error === null) {
					// A close/switch invalidated this startup while it was awaiting the
					// provider. The newer lifecycle owner is responsible for settlement.
					yield* reactorEffects.complete(reactorInput.commandId);
					return;
				}
				const persistedError = yield* persistMessage(sessionId, {
					_tag: "error",
					message: restarted.error.reason,
				});
				yield* ndjsonAppend(sessionId, persistedError);
				// Keep the durable turn active. Explicit Retry and boot recovery can
				// replay this exact provider request without reconstructing user input.
				yield* setStatus(sessionId, "error");
				// Authentication is recoverable through the inline login flow, so
				// acknowledge this failed side effect and let a fresh turn retry it.
				// Other transient failures retain the existing replay behavior.
				if (!isAuthenticationRequired(restarted.error.reason)) {
					return yield* Effect.die(
						new Error(
							`Provider turn could not be started after durable intent: ${restarted.error.reason}`,
						),
					);
				}
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
				const admitted = yield* sessionDomain
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
					.pipe(
						Effect.as(true),
						Effect.catchTag("TurnAlreadyRunning", () =>
							sessionDomain
								.dispatch({
									commandId: `${reactorInput.commandId}:requeue`,
									streamId: sessionId,
									command: {
										_tag: "EnqueueTurn",
										queueId: reactorInput.command.queueId,
										inputJson: reactorInput.command.inputJson,
										position: 0,
										createdAt: Date.now(),
										ready: true,
									},
								})
								.pipe(Effect.as(false)),
						),
					)
					.pipe(Effect.orDie);
				if (admitted) {
					rememberActiveTurn(
						sessionId,
						AgentTurnId.make(reactorInput.command.turnId),
					);
				}
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
