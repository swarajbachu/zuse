import {
	GitPrCheckRun,
	type GitPrDetails,
	type GitPrInfo,
} from "@zuse/contracts";
import type { MessageKey } from "@zuse/i18n";
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

export function gitHubStatusMessageKey(
	pr: GitPrInfo | null,
): MessageKey | null {
	if (!pr) return null;
	if (pr.monitoringPaused)
		return "projects:github_observation_monitoring_paused";
	switch (pr.prCapability) {
		case "authentication":
			return "projects:github_observation_authentication";
		case "access":
			return "projects:github_observation_access";
		case "rate_limited":
			return "projects:github_observation_rate_limited";
		case "offline":
			return "projects:github_observation_offline";
		case "timeout":
			return "projects:github_observation_timeout";
		case "unknown":
			return "projects:github_observation_unavailable";
		default:
			return pr.stale
				? pr.state === "none"
					? "projects:github_observation_loading"
					: "projects:github_observation_cached"
				: pr.checksComplete === false
					? "projects:github_observation_incomplete_checks"
					: null;
	}
}
