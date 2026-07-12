import { projectSessionEvent } from "@zuse/client-runtime/session-events";
import type { Message, SessionId } from "@zuse/contracts";
import { Effect, Stream } from "effect";
import type { SystemRpcClient } from "./rpc-client.ts";

export const waitForSessionMessages = (
	client: SystemRpcClient,
	sessionId: SessionId,
	predicate: (message: Message) => boolean,
	count = 1,
	timeoutMs = 10_000,
): Promise<ReadonlyArray<Message>> =>
	Effect.runPromise(
		client["session.events"]({ sessionId }).pipe(
			Stream.map(projectSessionEvent),
			Stream.filter(
				(projection) =>
					projection._tag === "message" && predicate(projection.message),
			),
			Stream.map((projection) =>
				projection._tag === "message" ? projection.message : null,
			),
			Stream.filter((message): message is Message => message !== null),
			Stream.take(count),
			Stream.runCollect,
			Effect.map((messages) => Array.from(messages)),
			Effect.timeout(timeoutMs),
		),
	);
