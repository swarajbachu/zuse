import type { GitPrCheckRun } from "@zuse/contracts";
export type CheckKind = "failure" | "pending" | "success" | "neutral";

export const checkKind = (check: GitPrCheckRun): CheckKind => {
	if (check.conclusion === null && check.status !== "completed")
		return "pending";
	switch (check.conclusion) {
		case "success":
			return "success";
		case "failure":
		case "cancelled":
		case "timed_out":
		case "action_required":
			return "failure";
		default:
			return "neutral";
	}
};

/** Derive all summary fields from the same runs rendered in the check list. */
export const summarizeChecks = (checks: readonly GitPrCheckRun[]) => {
	let checksRunning = 0;
	let checksFailing = 0;
	for (const check of checks) {
		const kind = checkKind(check);
		if (kind === "pending") checksRunning++;
		else if (kind === "failure") checksFailing++;
	}
	return {
		checks:
			checks.length === 0
				? ("none" as const)
				: checksFailing > 0
					? ("failure" as const)
					: checksRunning > 0
						? ("pending" as const)
						: ("success" as const),
		checksTotal: checks.length,
		checksRunning,
		checksFailing,
		checksPassing: checks.length - checksRunning - checksFailing,
	};
};

export type CheckCounts = Readonly<Record<CheckKind, number>> & {
	readonly total: number;
};

export const countChecks = (checks: readonly GitPrCheckRun[]): CheckCounts => {
	const counts = { failure: 0, pending: 0, success: 0, neutral: 0 };
	for (const check of checks) counts[checkKind(check)]++;
	return { ...counts, total: checks.length };
};

const CHECK_KIND_RANK: Record<CheckKind, number> = {
	failure: 0,
	pending: 1,
	success: 2,
	neutral: 3,
};

/** Attention order — failing first, then running — stable within each kind. */
export const sortChecks = (checks: readonly GitPrCheckRun[]): GitPrCheckRun[] =>
	[...checks].sort(
		(a, b) => CHECK_KIND_RANK[checkKind(a)] - CHECK_KIND_RANK[checkKind(b)],
	);
