import type { PtyCatalog, PtySummary } from "@zuse/contracts";

export type TerminalCatalog = Readonly<{
	terminals: ReadonlyArray<PtySummary>;
	/** Null means a legacy server did not publish an authoritative policy. */
	liveLimit: number | null;
}>;

export const terminalOwnerLimitMessage = (limit: number | null): string =>
	limit === null
		? "Terminal limit reached. Close a terminal, then retry."
		: `Terminal limit reached (${limit}). Close a terminal, then retry.`;

/** Returns the shared recovery copy only for a server owner-cap failure. */
export const terminalOwnerLimitFailureMessage = (
	cause: unknown,
): string | null => {
	if (
		typeof cause !== "object" ||
		cause === null ||
		!("_tag" in cause) ||
		cause._tag !== "PtyOwnerLimitError"
	) {
		return null;
	}
	const limit =
		"limit" in cause && typeof cause.limit === "number" ? cause.limit : null;
	return terminalOwnerLimitMessage(limit);
};

const isLegacyTerminalCatalog = (
	result: PtyCatalog | ReadonlyArray<PtySummary>,
): result is ReadonlyArray<PtySummary> => Array.isArray(result);

/** Normalizes mixed-version `pty.list` results without guessing server policy. */
export const normalizeTerminalCatalog = (
	result: PtyCatalog | ReadonlyArray<PtySummary>,
): TerminalCatalog =>
	isLegacyTerminalCatalog(result)
		? { terminals: result, liveLimit: null }
		: { terminals: result.terminals, liveLimit: result.liveLimit };
