import {
	type DiffLine,
	parseUnifiedPatch,
} from "@zuse/client-runtime/timeline";
import type { GitReviewPatch } from "@zuse/contracts";

export type PreparedReviewPatch = {
	readonly error: string | null;
	readonly lines: readonly DiffLine[];
	readonly mode: GitReviewPatch["result"]["mode"];
	readonly path: string;
	readonly truncated: boolean;
};

/**
 * Detach parsed line strings from the full patch allocation. The prepared model
 * deliberately omits the raw patch so it can be reclaimed after streaming.
 */
const detachLine = (line: DiffLine): DiffLine => ({
	...line,
	text: ` ${line.text}`.slice(1),
});

export const prepareReviewPatch = (
	patch: GitReviewPatch,
): PreparedReviewPatch => ({
	path: patch.path,
	error: patch.error,
	mode: patch.result.mode,
	truncated: patch.result.truncated,
	lines:
		patch.error === null && patch.result.mode !== "binary"
			? parseUnifiedPatch(patch.result.patch).map(detachLine)
			: [],
});

export const prepareReviewLines = (
	path: string,
	lines: readonly DiffLine[],
): PreparedReviewPatch => ({
	path,
	error: null,
	mode: "worktree",
	truncated: false,
	lines: lines.map(detachLine),
});
