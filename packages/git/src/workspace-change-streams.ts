import type { FolderId, WorktreeId } from "@zuse/contracts";
import { Data, Effect, RcMap, type Scope, Stream } from "effect";

type WorkspaceChangeRevision = Readonly<{ revision: number }>;

type WorkspaceChangeSource<E> = (
	folderId: FolderId,
	worktreeId: WorktreeId | null,
) => Stream.Stream<WorkspaceChangeRevision, E>;

const IDLE_TIME_TO_LIVE = "2 seconds";

class CheckoutIdentity extends Data.Class<{
	readonly folderId: FolderId;
	readonly worktreeId: WorktreeId | null;
}> {}

/**
 * Reference-counted fanout for checkout invalidation streams. Each checkout
 * owns at most one source while retained, and the complete shared-stream
 * resource is removed after the final subscriber's idle grace expires.
 */
export type WorkspaceChangeStreams<E> = Readonly<{
	stream: (
		folderId: FolderId,
		worktreeId: WorktreeId | null,
	) => Stream.Stream<WorkspaceChangeRevision, E>;
	retainedCheckoutCount: Effect.Effect<number>;
}>;

export const makeWorkspaceChangeStreams = <E>(
	source: WorkspaceChangeSource<E>,
): Effect.Effect<WorkspaceChangeStreams<E>, never, Scope.Scope> =>
	Effect.gen(function* () {
		const entries = yield* RcMap.make({
			lookup: (identity: CheckoutIdentity) =>
				Stream.share(source(identity.folderId, identity.worktreeId), {
					capacity: 1,
					strategy: "sliding",
					replay: 1,
					idleTimeToLive: IDLE_TIME_TO_LIVE,
				}),
			idleTimeToLive: IDLE_TIME_TO_LIVE,
		});

		return {
			stream: (folderId, worktreeId) =>
				Stream.unwrap(
					RcMap.get(entries, new CheckoutIdentity({ folderId, worktreeId })),
				),
			retainedCheckoutCount: RcMap.keys(entries).pipe(
				Effect.map((keys) => Array.from(keys).length),
			),
		};
	});
