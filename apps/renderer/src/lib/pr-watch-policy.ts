import type { GitPrDetails } from "@zuse/contracts";
import { checkKind } from "./pr-checks.ts";

// Includes the head and run identity so new commits and reruns can be repaired,
// while repeated polls of an unchanged failure do not produce extra messages.
export function prFailureKey(details: GitPrDetails): string | null {
	if (
		details.state !== "open" ||
		details.isDraft ||
		details.checks !== "failure" ||
		details.checkRuns.some((check) => checkKind(check) === "pending")
	)
		return null;
	const failures = details.checkRuns
		.filter((check) => checkKind(check) === "failure")
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
