import type { GitPrDetails } from "@zuse/contracts";

export const isFailedPrCheck = (
	check: GitPrDetails["checkRuns"][number],
): boolean =>
	check.status === "completed" &&
	["failure", "timed_out", "cancelled", "action_required"].includes(
		check.conclusion ?? "",
	);

// Includes the head and run identity so new commits and reruns can be repaired,
// while repeated polls of an unchanged failure do not produce extra messages.
export function prFailureKey(details: GitPrDetails): string | null {
	if (
		details.state !== "open" ||
		details.isDraft ||
		details.checks !== "failure" ||
		details.checkRuns.some((check) => check.status !== "completed")
	)
		return null;
	const failures = details.checkRuns
		.filter(isFailedPrCheck)
		.map((check) => [
			check.name,
			check.url,
			check.runId,
			check.jobId,
			check.startedAt?.toISOString() ?? null,
			check.conclusion,
		]);
	if (failures.length === 0) return null;
	return JSON.stringify([
		details.url,
		details.headSha ?? null,
		failures.sort((left, right) =>
			JSON.stringify(left).localeCompare(JSON.stringify(right)),
		),
	]);
}
