import {
	GitPrCheckRun,
	type GitPrDetails,
	type GitPrInfo,
} from "@zuse/contracts";
import { summarizeChecks } from "./pr-checks.ts";

/** One check snapshot for the header, summary, and detailed PR view. */
export function resolveGitPrState(
	pr: GitPrInfo | null,
	rawDetails: GitPrDetails | null,
	branch: string | null,
) {
	const details =
		rawDetails?.headBranch === branch &&
		(pr?.state === "none" || pr === null || rawDetails.url === pr.url)
			? rawDetails
			: null;
	const checkRuns = pr?.checkRuns ?? details?.checkRuns ?? null;
	const summary = checkRuns === null ? null : summarizeChecks(checkRuns);
	const metadata = new Map(
		(pr?.headSha && details?.headSha !== pr.headSha
			? []
			: details?.checkRuns
		)?.map((run) => [JSON.stringify([run.name, run.url]), run]),
	);
	const complete = pr?.checksComplete !== false;
	return {
		pr:
			pr && checkRuns
				? {
						...pr,
						...summary,
						...(!complete && summary?.checks !== "failure"
							? { checks: "pending" as const }
							: {}),
						checkRuns,
					}
				: pr,
		checkRuns,
		details:
			details && checkRuns
				? {
						...details,
						...summary,
						...(!complete && summary?.checks !== "failure"
							? { checks: "pending" as const }
							: {}),
						checkRuns: checkRuns.map((run) =>
							GitPrCheckRun.make({
								...metadata.get(JSON.stringify([run.name, run.url])),
								...run,
							}),
						),
					}
				: details,
	};
}

export function gitHubStatusLabel(pr: GitPrInfo | null): string | null {
	if (!pr) return null;
	if (pr.monitoringPaused) return "GitHub monitoring paused · Retry";
	switch (pr.prCapability) {
		case "authentication":
			return "Reconnect GitHub";
		case "access":
			return "GitHub access unavailable";
		case "rate_limited":
			return "GitHub rate limited · Refresh paused";
		case "offline":
			return "GitHub offline · Cached status";
		case "timeout":
			return "GitHub timed out · Cached status";
		case "unknown":
			return "GitHub status unavailable";
		default:
			return pr.stale
				? pr.state === "none"
					? "Loading GitHub status…"
					: "Cached GitHub status"
				: pr.checksComplete === false
					? "Checks are incomplete"
					: null;
	}
}
