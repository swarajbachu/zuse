import type {
	FolderId,
	GitReviewPatch,
	GitReviewSummary,
	WorktreeId,
} from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";

import { classifyGit } from "../lib/git-rpc.ts";
import { getRpcClient } from "../lib/rpc-client.ts";
import { createAtomStore as create } from "../state/atom-store.ts";

type ReviewState = {
	readonly summaries: Record<string, GitReviewSummary>;
	readonly patches: Record<string, Readonly<Record<string, GitReviewPatch>>>;
	readonly loading: Record<string, boolean>;
	readonly errors: Record<string, string | null>;
	readonly refresh: (
		folderId: FolderId,
		worktreeId?: WorktreeId | null,
	) => Promise<void>;
	readonly ensurePatch: (
		folderId: FolderId,
		worktreeId: WorktreeId | null | undefined,
		path: string,
	) => Promise<void>;
};

const streamFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
const patchRequests = new Map<string, Promise<void>>();

export const gitReviewKey = (
	folderId: FolderId,
	worktreeId: WorktreeId | null | undefined,
): string => `${folderId}:${worktreeId ?? "main"}`;

export const useGitReviewStore = create<ReviewState>((set) => ({
	summaries: {},
	patches: {},
	loading: {},
	errors: {},
	ensurePatch: async (folderId, worktreeId, path) => {
		const key = gitReviewKey(folderId, worktreeId);
		const requestKey = `${key}:${path}`;
		const pending = patchRequests.get(requestKey);
		if (pending !== undefined) return pending;
		const request = (async () => {
			const client = await getRpcClient();
			const result = await classifyGit(
				client["git.diff"]({
					folderId,
					worktreeId: worktreeId ?? null,
					path,
				}),
			);
			if (!result.ok) {
				set((state) => ({
					errors: { ...state.errors, [key]: result.message },
				}));
				return;
			}
			set((state) => ({
				patches: {
					...state.patches,
					[key]: {
						...(state.patches[key] ?? {}),
						[path]: { path, result: result.value, error: null },
					},
				},
			}));
		})().finally(() => patchRequests.delete(requestKey));
		patchRequests.set(requestKey, request);
		return request;
	},
	refresh: async (folderId, worktreeId) => {
		const key = gitReviewKey(folderId, worktreeId);
		for (const [activeKey, fiber] of streamFibers) {
			if (activeKey === key) continue;
			await Effect.runPromise(Fiber.interrupt(fiber));
			streamFibers.delete(activeKey);
		}
		const previousFiber = streamFibers.get(key);
		if (previousFiber !== undefined) {
			await Effect.runPromise(Fiber.interrupt(previousFiber));
			streamFibers.delete(key);
		}
		set((state) => ({
			loading: { ...state.loading, [key]: true },
			errors: { ...state.errors, [key]: null },
			// A refresh can follow a conflict resolution or edit. Drop the rendered
			// patches immediately so the old comparison cannot remain visible while
			// the new summary and patch stream are loading.
			patches: { ...state.patches, [key]: {} },
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
