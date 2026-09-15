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
		details?.checkRuns.map((run) => [JSON.stringify([run.name, run.url]), run]),
	);
	return {
		pr: pr && checkRuns ? { ...pr, ...summary, checkRuns } : pr,
		checkRuns,
		details:
			details && checkRuns
				? {
						...details,
						...summary,
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
