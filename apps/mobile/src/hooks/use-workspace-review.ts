import type {
	FolderId,
	GitReviewScope,
	GitReviewSummary,
	WorktreeId,
} from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type PreparedReviewPatch,
	prepareReviewPatch,
} from "~/lib/review-diff-model";
import { reviewScopeCompatibilityError } from "~/lib/review-scope";
import {
	loadWorkspaceReview,
	streamWorkspaceReviewPatches,
} from "~/rpc/actions";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

export function useWorkspaceReview(options: {
	connection: WsProtocolOptions | null;
	folderId?: FolderId;
	worktreeId?: WorktreeId | null;
	scope?: GitReviewScope;
	enabled?: boolean;
}) {
	const [summary, setSummary] = useState<GitReviewSummary | null>(null);
	const [patches, setPatches] = useState<
		Readonly<Record<string, PreparedReviewPatch>>
	>({});
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [revision, setRevision] = useState(0);
	const generationRef = useRef(0);

	const refresh = useCallback(() => {
		setRefreshing(true);
		setRevision((current) => current + 1);
	}, []);

	useEffect(() => {
		if (
			options.enabled === false ||
			options.connection === null ||
			options.folderId === undefined
		) {
			setLoading(false);
			setRefreshing(false);
			return;
		}

		const generation = generationRef.current + 1;
		generationRef.current = generation;
		const request = {
			connection: options.connection,
			folderId: options.folderId,
			worktreeId: options.worktreeId,
			scope: options.scope,
		};
		setError(null);
		setSummary(null);
		setPatches({});
		if (revision === 0) setLoading(true);

		const reviewProgram = Effect.gen(function* () {
			const nextSummary = yield* loadWorkspaceReview(request);
			const compatibilityError = reviewScopeCompatibilityError(
				options.scope,
				nextSummary.scope,
			);
			if (compatibilityError !== null) {
				return yield* Effect.fail(new Error(compatibilityError));
			}
			yield* Effect.sync(() => {
				if (generationRef.current !== generation) return;
				setSummary(nextSummary);
				setLoading(false);
			});
			yield* Stream.runForEach(streamWorkspaceReviewPatches(request), (patch) =>
				Effect.sync(() => {
					if (generationRef.current !== generation) return;
					const prepared = prepareReviewPatch(patch);
					setPatches((current) => ({
						...current,
						[prepared.path]: prepared,
					}));
				}),
			);
		});
		const reviewFiber = Effect.runFork(reviewProgram);
		void Effect.runPromise(Fiber.join(reviewFiber))
			.catch((cause) => {
				if (generationRef.current !== generation) return;
				setError(cause instanceof Error ? cause.message : String(cause));
				setLoading(false);
			})
			.finally(() => {
				if (generationRef.current === generation) setRefreshing(false);
			});

		return () => {
			if (generationRef.current === generation) generationRef.current += 1;
			Effect.runFork(Fiber.interrupt(reviewFiber));
		};
	}, [
		options.connection,
		options.enabled,
		options.folderId,
		options.scope,
		options.worktreeId,
		revision,
	]);

	return { error, loading, patches, refresh, refreshing, summary } as const;
}
