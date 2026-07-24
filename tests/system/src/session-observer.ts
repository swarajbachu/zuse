import type {
	AgentTurnId,
	Message,
	SessionId,
	SessionTimelineFrame,
} from "@zuse/contracts";
import { Effect, Stream } from "effect";
import type { SystemRpcClient } from "./rpc-client.ts";

export const sessionFrameMessages = (
	frame: SessionTimelineFrame,
): ReadonlyArray<Message> => {
	if (frame.kind === "snapshot") return frame.projection.messages;
	if (frame.kind === "event" && frame.event._tag === "MessagePersisted") {
		return [frame.event.message];
	}
	return [];
};

export const sessionFrameVersion = (frame: SessionTimelineFrame): number =>
	frame.kind === "event" ? frame.streamVersion : frame.throughVersion;

export const waitForSessionMessages = (
	client: SystemRpcClient,
	sessionId: SessionId,
	predicate: (message: Message) => boolean,
	count = 1,
	timeoutMs = 10_000,
): Promise<ReadonlyArray<Message>> =>
	Effect.runPromise(
		client["session.events"]({ sessionId }).pipe(
			Stream.flatMap((frame) =>
				Stream.fromIterable(sessionFrameMessages(frame)),
			),
			Stream.filter(predicate),
			Stream.take(count),
			Stream.runCollect,
			Effect.map((messages) => Array.from(messages)),
			Effect.timeout(timeoutMs),
		),
	);

export const waitForActiveTurn = (
	client: SystemRpcClient,
	sessionId: SessionId,
	timeoutMs = 10_000,
): Promise<AgentTurnId> =>
	Effect.runPromise(
		client["session.events"]({ sessionId }).pipe(
			Stream.map((frame): AgentTurnId | null => {
				if (frame.kind === "snapshot") {
					return frame.projection.currentTurn?.turnId ?? null;
				}
				if (
					frame.kind === "event" &&
					(frame.event._tag === "TurnStarted" ||
						frame.event._tag === "TurnPhaseSet")
				) {
					return frame.event.turnId;
				}
				return null;
			}),
			Stream.filter((turnId): turnId is AgentTurnId => turnId !== null),
			Stream.runHead,
			Effect.flatMap((turnId) =>
				turnId._tag === "Some"
					? Effect.succeed(turnId.value)
					: Effect.fail(
							new Error("Session stream ended without an active turn."),
						),
			),
			Effect.timeout(timeoutMs),
		),
	);
