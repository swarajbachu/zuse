import {
	type AgentSessionNotFoundError,
	AgentTurnId,
	type MessageContent,
	MessageId,
	SessionId,
	SessionStartError,
} from "@zuse/contracts";
import type { SessionDomainApi } from "@zuse/domain/engine/session-domain";
import { Cause, Effect } from "effect";
import { isProviderAuthenticationRequired } from "../../provider/provider-auth-failure.ts";
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

const PROVIDER_DELIVERY_OUTCOME_UNKNOWN =
	"Zuse could not confirm whether the agent received this message before the runtime stopped. Zuse did not send it again to avoid a duplicate. Retry the message if no response appears.";

const isProvenUndeliveredProviderSend = (
	cause: Cause.Cause<AgentSessionNotFoundError>,
): boolean => {
	const reason = cause.reasons[0];
	return (
		cause.reasons.length === 1 &&
		reason !== undefined &&
		Cause.isFailReason(reason) &&
		reason.error._tag === "AgentSessionNotFoundError"
	);
};

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
		idOverride?: MessageId,
		turnIdOverride?: AgentTurnId,
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
	const recoverUnknownProviderDelivery = (
		effectId: string,
		sessionId: SessionId,
		turnId: AgentTurnId,
	) =>
		Effect.gen(function* () {
			// The provider call is outside SQLite. An ambiguous failure or retained
			// `started` row may have crossed the external side-effect boundary. Recover
			// the local stream idempotently, but never send the request again.
			yield* persistMessage(
				sessionId,
				{ _tag: "error", message: PROVIDER_DELIVERY_OUTCOME_UNKNOWN },
				MessageId.make(`provider-outcome-unknown:${effectId}`),
				turnId,
			);
			yield* settleTurnFromReactor(sessionId, turnId, "error");
			yield* reactorEffects.markOutcomeUnknown(effectId);
		});
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
			const activeTurnId = yield* resolveActiveTurn(sessionId);
			if (activeTurnId === undefined) {
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
			const carriesLegacyPrompt =
				request.initialPrompt !== null && request.initialPrompt.length > 0;
			if (carriesLegacyPrompt) {
				// Retained pre-atomic-creation rows can still carry their user prompt in
				// provider.start. Fence that legacy external send exactly like a normal
				// provider turn; a crash cannot safely distinguish accepted from unsent.
				const effect = yield* reactorEffects.begin(reactorInput.commandId);
				if (effect === "completed" || effect === "outcome-unknown") return;
				if (effect === "already-started") {
					yield* recoverUnknownProviderDelivery(
						reactorInput.commandId,
						sessionId,
						activeTurnId,
					);
					return;
				}
			}
			const start = ensureForTurn(sessionId, {
				initialPrompt: request.initialPrompt ?? undefined,
				initialTurnId: request.initialTurnId ?? activeTurnId,
				modelOptions,
				enableSubagents: request.enableSubagents,
				forkFromResume: request.forkFromResume,
				postBootStatus: request.postBootStatus,
			});
			if (request.background) {
				yield* start.pipe(
					Effect.catch((error) =>
						Effect.gen(function* () {
							if (carriesLegacyPrompt) {
								yield* recoverUnknownProviderDelivery(
									reactorInput.commandId,
									sessionId,
									activeTurnId,
								);
								return;
							}
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
			const sessionId = SessionId.make(reactorInput.streamId);
			const resolvedTurnId = yield* resolveActiveTurn(sessionId);
			if (resolvedTurnId !== AgentTurnId.make(reactorInput.command.turnId)) {
				yield* reactorEffects.complete(reactorInput.commandId);
				return;
			}
			const effect = yield* reactorEffects.begin(reactorInput.commandId);
			if (effect === "completed" || effect === "outcome-unknown") return;
			if (effect === "already-started") {
				const turnId = AgentTurnId.make(reactorInput.command.turnId);
				yield* recoverUnknownProviderDelivery(
					reactorInput.commandId,
					sessionId,
					turnId,
				);
				return;
			}
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
				// Close the ambiguity window before projection/status bookkeeping. A
				// restart after this point observes completion and cannot resend.
				yield* reactorEffects.complete(reactorInput.commandId);
				yield* setStatus(sessionId, "running");
				return;
			}
			if (sent._tag === "Failure") {
				if (!isProvenUndeliveredProviderSend(sent.cause)) {
					yield* recoverUnknownProviderDelivery(
						reactorInput.commandId,
						sessionId,
						AgentTurnId.make(reactorInput.command.turnId),
					);
					return;
				}
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
				// Authentication is recoverable through explicit resume, which replays
				// this same durable turn. Completing the receipt prevents catch-up from
				// racing that user-driven retry; other transient failures stay replayable.
				if (!isProviderAuthenticationRequired(restarted.error.reason)) {
					// ProviderService.send can fail only with AgentSessionNotFoundError,
					// and ensureForTurn reports this branch only when its replacement send
					// also never reached a live provider handle. That is positive evidence
					// that delivery did not occur, so this exact durable turn remains safe
					// for explicit retry. All interrupted/uncertain paths retain `started`.
					yield* reactorEffects.releaseUndelivered(reactorInput.commandId);
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
