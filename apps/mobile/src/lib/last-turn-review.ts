import {
	extractFileChanges,
	type FileChange,
	mergeFileChanges,
	summarizeFileChanges,
	type TimelineTurn,
} from "@zuse/client-runtime/timeline";
import { GitReviewFile, GitReviewSummary } from "@zuse/contracts";

import {
	type PreparedReviewPatch,
	prepareReviewLines,
} from "./review-diff-model";

export type LocalReview = {
	readonly summary: GitReviewSummary;
	readonly patches: Readonly<Record<string, PreparedReviewPatch>>;
};

export const buildLastTurnReview = (
	turn: TimelineTurn | undefined,
): LocalReview => {
	const extractedChanges: FileChange[] = [];
	for (const message of turn?.body ?? []) {
		if (message.content._tag !== "tool_use") continue;
		extractedChanges.push(
			...extractFileChanges(message.content.tool, message.content.input),
		);
	}
	const changes = [...mergeFileChanges(extractedChanges)].sort((left, right) =>
		left.path.localeCompare(right.path),
	);
	const totals = summarizeFileChanges(changes);
	const files = changes.map((change) =>
		GitReviewFile.make({
			path: change.path,
			oldPath: null,
			kind: "modified",
			additions: change.added,
			deletions: change.removed,
			binary: false,
			conflict: false,
			hasUncommittedChanges: true,
		}),
	);
	return {
		summary: GitReviewSummary.make({
			scope: "branch",
			baseRef: null,
			headRef: null,
			baseSha: "",
			headSha: "",
			files,
			additions: totals.added,
			deletions: totals.removed,
		}),
		patches: Object.fromEntries(
			changes.map((change) => [
				change.path,
				prepareReviewLines(change.path, change.lines),
			]),
		),
	};
};
