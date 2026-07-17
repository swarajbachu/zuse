import type {
	FolderId,
	GitReviewPatch,
	GitReviewSummary,
	WorktreeId,
} from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import { create } from "zustand";

import { classifyGit } from "../lib/git-rpc.ts";
import { getRpcClient } from "../lib/rpc-client.ts";

type ReviewState = {
	readonly summaries: Record<string, GitReviewSummary>;
	readonly patches: Record<string, Readonly<Record<string, GitReviewPatch>>>;
	readonly loading: Record<string, boolean>;
	readonly errors: Record<string, string | null>;
	readonly refresh: (
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Promise<void>;
};

const streamFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();

export const gitReviewKey = (
	folderId: FolderId,
	worktreeId: WorktreeId | null | undefined,
): string => `${folderId}:${worktreeId ?? "main"}`;

export const useGitReviewStore = create<ReviewState>((set) => ({
	summaries: {},
	patches: {},
	loading: {},
	errors: {},
	refresh: async (folderId, worktreeId) => {
		const key = gitReviewKey(folderId, worktreeId);
		const previousFiber = streamFibers.get(key);
		if (previousFiber !== undefined) {
			await Effect.runPromise(Fiber.interrupt(previousFiber));
			streamFibers.delete(key);
		}
		set((state) => ({
			loading: { ...state.loading, [key]: true },
			errors: { ...state.errors, [key]: null },
		}));
		const client = await getRpcClient();
		const summaryResult = await classifyGit(
			client["git.reviewSummary"]({
				folderId,
				worktreeId: worktreeId ?? null,
			}),
		);
		if (!summaryResult.ok) {
			set((state) => ({
				loading: { ...state.loading, [key]: false },
				errors: { ...state.errors, [key]: summaryResult.message },
			}));
			return;
		}
		const summary = summaryResult.value;
		const paths = new Set(summary.files.map((file) => file.path));
		set((state) => ({
			summaries: { ...state.summaries, [key]: summary },
			patches: {
				...state.patches,
				[key]: Object.fromEntries(
					Object.entries(state.patches[key] ?? {}).filter(([path]) =>
						paths.has(path),
					),
				),
			},
		}));

		const program = Stream.runForEach(
			client["git.reviewPatches"]({
				folderId,
				worktreeId: worktreeId ?? null,
			}),
			(patch) =>
				Effect.sync(() =>
					set((state) => ({
						patches: {
							...state.patches,
							[key]: { ...(state.patches[key] ?? {}), [patch.path]: patch },
						},
					})),
				),
		).pipe(
			Effect.catch((error) =>
				Effect.sync(() =>
					set((state) => ({
						errors: { ...state.errors, [key]: String(error) },
					})),
				),
			),
			Effect.ensuring(
				Effect.sync(() => {
					streamFibers.delete(key);
					set((state) => ({
						loading: { ...state.loading, [key]: false },
					}));
				}),
			),
		);
		const fiber = Effect.runFork(program);
		streamFibers.set(key, fiber);
	},
}));
