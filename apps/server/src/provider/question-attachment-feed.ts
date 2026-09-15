import type {
	QuestionAttachment,
	QuestionAttachmentChange,
} from "@zuse/contracts";
import { Effect, PubSub, Stream } from "effect";

type QuestionAttachmentSnapshot = Extract<
	QuestionAttachmentChange,
	{ readonly _tag: "snapshot" }
>;

/**
 * Bounded, conflated publication of live question callback authority.
 *
 * Every publication is a complete snapshot. A stalled subscriber may skip
 * intermediate churn, but the sliding-one mailbox always converges to current
 * truth instead of losing a delta and remaining permanently desynchronized.
 */
export const makeQuestionAttachmentSnapshotFeed = Effect.gen(function* () {
	const snapshots = yield* PubSub.sliding<QuestionAttachmentSnapshot>(1);
	return {
		publish: (
			attachments: ReadonlyArray<QuestionAttachment>,
		): Effect.Effect<void> => {
			const snapshot: QuestionAttachmentSnapshot = {
				_tag: "snapshot",
				attachments,
			};
			return PubSub.publish(snapshots, snapshot).pipe(Effect.asVoid);
		},
		stream: (
			current: () => ReadonlyArray<QuestionAttachment>,
		): Stream.Stream<QuestionAttachmentSnapshot> =>
			Stream.unwrap(
				Effect.gen(function* () {
					const changes = yield* PubSub.subscribe(snapshots);
					return Stream.concat(
						Stream.succeed({
							_tag: "snapshot" as const,
							attachments: current(),
						}),
						Stream.fromSubscription(changes),
					);
				}),
			),
	};
});
