import {
	extractFileChanges,
	type FileChange,
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
	const byPath = new Map<string, FileChange>();
	for (const message of turn?.body ?? []) {
		if (message.content._tag !== "tool_use") continue;
		for (const change of extractFileChanges(
			message.content.tool,
			message.content.input,
		)) {
			const current = byPath.get(change.path);
			byPath.set(
				change.path,
				current === undefined
					? change
					: {
							...current,
							added: current.added + change.added,
							removed: current.removed + change.removed,
							lines: [...current.lines, ...change.lines],
						},
			);
		}
	}
	const changes = [...byPath.values()].sort((left, right) =>
		left.path.localeCompare(right.path),
	);
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
			additions: files.reduce((total, file) => total + file.additions, 0),
			deletions: files.reduce((total, file) => total + file.deletions, 0),
		}),
		patches: Object.fromEntries(
			changes.map((change) => [
				change.path,
				prepareReviewLines(change.path, change.lines),
			]),
		),
	};
};
