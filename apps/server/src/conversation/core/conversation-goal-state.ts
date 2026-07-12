/** Maintains live goal state while SQLite remains the durable authority. */
import {
	MessageContent,
	type SessionId,
	type ThreadGoal,
} from "@zuse/contracts";
import { Effect, Option, PubSub, Ref, Schema, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";

export interface ConversationGoalState {
	readonly publish: (
		sessionId: SessionId,
		goal: ThreadGoal | null,
	) => Effect.Effect<void>;
	readonly stream: (
		sessionId: SessionId,
		loadInitial: Effect.Effect<ThreadGoal | null>,
	) => Stream.Stream<{
		readonly sessionId: SessionId;
		readonly goal: ThreadGoal | null;
	}>;
	readonly current: (sessionId: SessionId) => ThreadGoal | null | undefined;
	readonly latestUserMessageMatches: (
		sessionId: SessionId,
		text: string,
	) => Effect.Effect<boolean>;
}

const decodeMessageContent = Schema.decodeUnknownOption(
	Schema.fromJsonString(MessageContent),
);

export const makeConversationGoalState = Effect.fn(
	"ConversationGoalState.make",
)(function* (): Effect.fn.Return<
	ConversationGoalState,
	never,
	SqlClient.SqlClient
> {
	const sql = yield* SqlClient.SqlClient;
	const channels = yield* Ref.make<
		ReadonlyMap<
			SessionId,
			PubSub.PubSub<{
				readonly sessionId: SessionId;
				readonly goal: ThreadGoal | null;
			}>
		>
	>(new Map());
	const currentBySession = new Map<SessionId, ThreadGoal | null>();

	const channel = Effect.fn("ConversationGoalState.channel")(function* (
		sessionId: SessionId,
	) {
		const existing = (yield* Ref.get(channels)).get(sessionId);
		if (existing !== undefined) return existing;
		const created = yield* PubSub.unbounded<{
			readonly sessionId: SessionId;
			readonly goal: ThreadGoal | null;
		}>();
		yield* Ref.update(channels, (all) => {
			const next = new Map(all);
			next.set(sessionId, created);
			return next;
		});
		return created;
	});

	const publish: ConversationGoalState["publish"] = (sessionId, goal) =>
		Effect.gen(function* () {
			currentBySession.set(sessionId, goal);
			yield* PubSub.publish(yield* channel(sessionId), {
				sessionId,
				goal,
			}).pipe(Effect.asVoid);
		});

	return {
		publish,
		current: (sessionId) => currentBySession.get(sessionId),
		stream: (sessionId, loadInitial) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const dequeue = yield* PubSub.subscribe(yield* channel(sessionId));
					const cached = currentBySession.get(sessionId);
					const initial = cached === undefined ? yield* loadInitial : cached;
					if (cached === undefined) currentBySession.set(sessionId, initial);
					return Stream.concat(
						Stream.succeed({ sessionId, goal: initial }),
						Stream.fromSubscription(dequeue),
					);
				}),
			),
		latestUserMessageMatches: (sessionId, text) =>
			Effect.gen(function* () {
				const rows = yield* sql<{ readonly content_json: string }>`
          SELECT content_json FROM messages
          WHERE session_id = ${sessionId} AND role = 'user'
          ORDER BY created_at DESC
          LIMIT 1
        `.pipe(Effect.orDie);
				const content = Option.flatMap(
					Option.fromNullishOr(rows[0]?.content_json),
					decodeMessageContent,
				);
				if (Option.isNone(content)) return false;
				const value = content.value;
				return (
					(value._tag === "user" || value._tag === "user_rich") &&
					value.goal === true &&
					value.text.trim() === text.trim()
				);
			}),
	};
});
