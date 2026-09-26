import { terminalOwnerLimitFailureMessage } from "@zuse/client-runtime/terminal-catalog";
import type { PtyOpenToken, PtySummary } from "@zuse/contracts";

export const findTerminalForOpenToken = (
	summaries: ReadonlyArray<PtySummary>,
	openToken: PtyOpenToken,
): PtySummary | undefined =>
	summaries.find(
		(summary) =>
			summary.openToken !== null &&
			String(summary.openToken) === String(openToken),
	);

export const terminalOpenFailureMessage = (
	cause: unknown,
	fallback = "Terminal could not be opened. Check the connection, then retry.",
): string => {
	const ownerLimit = terminalOwnerLimitFailureMessage(cause);
	if (ownerLimit !== null) return ownerLimit;
	if (typeof cause === "object" && cause !== null && "_tag" in cause) {
		if (cause._tag === "PtyOpenConflictError") {
			return "This terminal conflicts with an existing process. Close it, then reopen.";
		}
	}
	return fallback;
};
