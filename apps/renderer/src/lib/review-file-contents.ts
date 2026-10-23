import type { FileDiffLoadedFiles } from "@pierre/diffs";
import type { ExecutionRef } from "@zuse/client-runtime/resource-ref";
import type {
	FolderId,
	GitReviewFileContents,
	WorktreeId,
} from "@zuse/contracts";
import { CommandId } from "@zuse/contracts";

import { dispatchGitWorkspaceCommand } from "./git-workspace-client-bus.ts";

export interface ReviewFileRef {
	readonly path: string;
	readonly oldPath: string | null;
}

const inFlight = new Map<string, Promise<GitReviewFileContents>>();

/**
 * Both sides of one changed file, as review shows it: the base version and
 * the working tree. Concurrent requests for the same file share one read, so
 * expanding a hunk while the editor opens the same file costs one round trip.
 */
export const loadReviewFileContents = (
	ref: ExecutionRef,
	file: ReviewFileRef,
): Promise<GitReviewFileContents> => {
	const key = `${ref.environmentId}:${ref.folderId}:${ref.worktreeId ?? "main"}:${file.oldPath ?? ""}:${file.path}`;
	const pending = inFlight.get(key);
	if (pending !== undefined) return pending;
	const request = dispatchGitWorkspaceCommand<
		{
			readonly folderId: FolderId;
			readonly worktreeId: WorktreeId | null;
			readonly path: string;
			readonly oldPath: string | null;
		},
		GitReviewFileContents
	>({
		ref,
		kind: "git.reviewFileContents",
		commandId: CommandId.make(`git-review-file:${crypto.randomUUID()}`),
		payload: {
			folderId: ref.folderId,
			worktreeId: ref.worktreeId,
			path: file.path,
			oldPath: file.oldPath,
		},
	})
		.then(({ result }) => result)
		.finally(() => inFlight.delete(key));
	inFlight.set(key, request);
	return request;
};

/**
 * Full file contents for a partial diff, so its hunks can expand into the
 * surrounding code. A file with no working-tree side (deleted) has nothing
 * to expand into, so it stays partial.
 */
export const loadReviewDiffFiles = async (
	ref: ExecutionRef,
	file: ReviewFileRef,
	cacheKey: string | undefined,
): Promise<FileDiffLoadedFiles> => {
	const contents = await loadReviewFileContents(ref, file);
	if (contents.newContent === null)
		throw new Error(`${file.path} has no working-tree contents to expand.`);
	const newFile = {
		name: file.path,
		contents: contents.newContent,
		...(cacheKey === undefined ? {} : { cacheKey: `${cacheKey}:new` }),
	};
	return contents.oldContent === null
		? { oldFile: null, newFile }
		: {
				oldFile: {
					name: file.oldPath ?? file.path,
					contents: contents.oldContent,
					...(cacheKey === undefined ? {} : { cacheKey: `${cacheKey}:old` }),
				},
				newFile,
			};
};
