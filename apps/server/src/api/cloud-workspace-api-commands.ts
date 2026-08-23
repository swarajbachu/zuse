import {
	CLOUD_RUNTIME_TURN_REPLY_MAX_LENGTH,
	type CloudRuntimeCommand,
	type CloudRuntimeCommandList,
	type Message,
} from "@zuse/contracts";
import { Effect, Schedule, Semaphore } from "effect";

/**
 * Pull-based delivery of public-API messages into the in-sandbox runtime.
 * The API stores pending commands durably and nudges the runtime through a
 * `runtime.command` gateway control frame; this pump then fetches, injects
 * each command through the idempotent domain path (`MessageService.sendMessage`
 * with the API-minted commandId), and acks so the API marks it delivered.
 * A failed injection is deliberately not acked — the row stays pending and is
 * retried on the next nudge, reconnect, or cron sweep.
 */
export interface CloudApiCommandPump {
	readonly drain: Effect.Effect<void>;
}

export const makeCloudApiCommandPump = Effect.fn(
	"CloudWorkspaceRuntime.makeApiCommandPump",
)(function* (input: {
	readonly fetchCommands: Effect.Effect<CloudRuntimeCommandList, unknown>;
	readonly deliver: (
		command: CloudRuntimeCommand,
	) => Effect.Effect<void, unknown>;
	readonly ack: (messageId: string) => Effect.Effect<unknown, unknown>;
}) {
	const lock = yield* Semaphore.make(1);
	const drain: Effect.Effect<void> = lock
		.withPermits(1)(
			Effect.gen(function* () {
				const list = yield* input.fetchCommands;
				for (const command of list.commands) {
					const delivered = yield* input.deliver(command).pipe(Effect.result);
					if (delivered._tag === "Failure") {
						yield* Effect.logWarning("cloud api command delivery failed", {
							messageId: command.messageId,
						});
						continue;
					}
					yield* input.ack(command.messageId).pipe(Effect.ignore);
				}
			}),
		)
		.pipe(Effect.retry(Schedule.recurs(3)), Effect.ignore);
	return { drain } satisfies CloudApiCommandPump;
});

/**
 * The bounded reply excerpt posted with a turn event: the final assistant text
 * of the page, capped so API rows and webhook payloads stay small. Tool
 * output and attachments are deliberately omitted — richer reads belong to the
 * encrypted transcript surface.
 */
export const cloudTurnReplyExcerpt = (
	messages: ReadonlyArray<Message>,
): { readonly text: string; readonly truncated: boolean } => {
	const last = [...messages]
		.reverse()
		.find(
			(message) =>
				message.role === "assistant" && message.content._tag === "assistant",
		);
	const full = last?.content._tag === "assistant" ? last.content.text : "";
	const truncated = full.length > CLOUD_RUNTIME_TURN_REPLY_MAX_LENGTH;
	return {
		text: truncated ? full.slice(0, CLOUD_RUNTIME_TURN_REPLY_MAX_LENGTH) : full,
		truncated,
	};
};
