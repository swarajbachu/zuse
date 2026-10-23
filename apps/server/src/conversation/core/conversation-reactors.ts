import type {
	ChatArchiveScriptError,
	ChatArchiveTimeoutError,
	ChatArchiveWorktreeError,
	ChatNotFoundError,
} from "@zuse/contracts";
import type {
	JobFailure,
	JobWorker,
} from "@zuse/domain/agent-engine/job-worker";
import { ChatEvent } from "@zuse/domain/chat/events";
import type { StoredEvent } from "@zuse/domain/engine/dispatch";
import {
	type ReactorDispatchInput,
	ReactorRunner,
} from "@zuse/domain/engine/reactor-runner";
import {
	makeSqlConsumerStorage,
	type SqlConsumerStorageError,
} from "@zuse/domain/engine/sql-consumer-storage";
import {
	type AutoNameCommand,
	autoNameReactorDefinition,
	type ChatArchiveCommand,
	type ChatDeleteCommand,
	chatArchiveReactorDefinition,
	chatDeleteReactorDefinition,
	type ReviewGuideRefreshCommand,
	reviewGuideReactorDefinition,
} from "@zuse/domain/reactors/conversation";
import { Effect, Schema, type Scope, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";

export type ChatArchiveReactorError =
	| ChatNotFoundError
	| ChatArchiveScriptError
	| ChatArchiveTimeoutError
	| ChatArchiveWorktreeError;

export interface ConversationReactorHandlers {
	readonly autoName: (
		input: ReactorDispatchInput<AutoNameCommand>,
	) => Effect.Effect<void>;
	readonly reviewGuide: (
		input: ReactorDispatchInput<ReviewGuideRefreshCommand>,
	) => Effect.Effect<void>;
	readonly chatArchive: (
		input: ReactorDispatchInput<ChatArchiveCommand>,
	) => Effect.Effect<void, ChatArchiveReactorError>;
	readonly chatDelete: (
		input: ReactorDispatchInput<ChatDeleteCommand>,
	) => Effect.Effect<void, ChatNotFoundError>;
}

export interface ConversationReactorRuntime {
	/**
	 * Runs every claimable provider job to completion, then queues naming work
	 * in the background. A provider job that failed for good surfaces as a
	 * defect so the command that implied it does not report success.
	 */
	readonly runSession: (sessionId: string) => Effect.Effect<void>;
	readonly runProviderStop: (sessionId: string) => Effect.Effect<void>;
	readonly runChatArchive: Effect.Effect<void, ChatArchiveReactorError>;
	readonly runChatDelete: Effect.Effect<void, ChatNotFoundError>;
	readonly catchUpAll: Effect.Effect<void>;
}

const decodeChatEvent = Schema.decodeUnknownEffect(
	Schema.fromJsonString(ChatEvent),
);

const serialize = Effect.fn("ConversationReactors.serialize")(function* <
	A,
	E,
	R,
>(effect: Effect.Effect<A, E, R>): Effect.fn.Return<Effect.Effect<A, E, R>> {
	const semaphore = yield* Semaphore.make(1);
	return Effect.suspend(() => semaphore.withPermits(1)(effect));
});

const failureCause = (failure: JobFailure): Error =>
	new Error(failure.failure.message, { cause: failure.failure.cause });

const drainProviderJobs = (worker: JobWorker, sessionId: string) =>
	worker.drainSession(sessionId).pipe(
		Effect.orDie,
		Effect.flatMap((failures) => {
			const surfaced = failures.find(
				(failure) => failure.job.request._tag === "provider.turn.send",
			);
			return surfaced === undefined
				? Effect.void
				: Effect.die(failureCause(surfaced));
		}),
	);

export const makeConversationReactorRuntime = Effect.fn(
	"ConversationReactors.make",
)(function* (
	handlers: ConversationReactorHandlers,
	worker: JobWorker,
	serviceScope: Scope.Scope,
): Effect.fn.Return<ConversationReactorRuntime, never, SqlClient.SqlClient> {
	const sql = yield* SqlClient.SqlClient;
	const sessionStorage = makeSqlConsumerStorage(sql);
	const chatStorage = () =>
		makeSqlConsumerStorage(sql, {
			streamKind: "chat",
			decodeEvent: decodeChatEvent,
		});

	const autoName = new ReactorRunner<
		StoredEvent,
		AutoNameCommand,
		SqlConsumerStorageError
	>(sessionStorage, handlers.autoName, autoNameReactorDefinition);
	const chatArchive = new ReactorRunner<
		StoredEvent<typeof ChatEvent.Type>,
		ChatArchiveCommand,
		SqlConsumerStorageError,
		never,
		ChatArchiveReactorError
	>(chatStorage(), handlers.chatArchive, chatArchiveReactorDefinition);
	const chatDelete = new ReactorRunner<
		StoredEvent<typeof ChatEvent.Type>,
		ChatDeleteCommand,
		SqlConsumerStorageError,
		never,
		ChatNotFoundError
	>(chatStorage(), handlers.chatDelete, chatDeleteReactorDefinition);

	const reviewGuide = new ReactorRunner<
		StoredEvent,
		ReviewGuideRefreshCommand,
		SqlConsumerStorageError
	>(sessionStorage, handlers.reviewGuide, reviewGuideReactorDefinition);
	const runAutoName = yield* serialize(autoName.catchUp().pipe(Effect.orDie));
	const runReviewGuide = yield* serialize(
		reviewGuide.catchUp().pipe(Effect.orDie),
	);
	const runSession = (sessionId: string) =>
		Effect.gen(function* () {
			yield* drainProviderJobs(worker, sessionId);

			yield* Effect.forkIn(runAutoName, serviceScope);
			yield* Effect.forkIn(runReviewGuide, serviceScope);
		});
	const runProviderStop = (sessionId: string) =>
		drainProviderJobs(worker, sessionId);
	const runChatArchive = yield* serialize(
		chatArchive.catchUp().pipe(
			Effect.asVoid,
			Effect.catch((error) =>
				error._tag === "ChatArchiveScriptError" ||
				error._tag === "ChatArchiveTimeoutError" ||
				error._tag === "ChatArchiveWorktreeError" ||
				error._tag === "ChatNotFoundError"
					? Effect.fail(error)
					: Effect.die(error),
			),
		),
	);
	const runChatDelete = yield* serialize(
		chatDelete.catchUp().pipe(
			Effect.asVoid,
			Effect.catch((error) =>
				error._tag === "ChatNotFoundError"
					? Effect.fail(error)
					: Effect.die(error),
			),
		),
	);

	return {
		runSession,
		runProviderStop,
		runChatArchive,
		runChatDelete,
		catchUpAll: Effect.all(
			(
				[
					["providers", worker.drain.pipe(Effect.orDie)],
					["naming", runAutoName],
					["review guides", runReviewGuide],
					[
						"chat lifecycle",
						runChatArchive.pipe(Effect.andThen(runChatDelete)),
					],
				] satisfies ReadonlyArray<
					readonly [string, Effect.Effect<unknown, unknown>]
				>
			).map(([name, effect]) =>
				effect.pipe(
					Effect.catchCause((cause) =>
						Effect.logError(
							`[ConversationReactors] ${name} recovery failed: ${String(cause)}`,
						),
					),
				),
			),
			{ concurrency: "unbounded", discard: true },
		),
	};
});
