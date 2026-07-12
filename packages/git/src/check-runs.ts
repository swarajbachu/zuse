export type PrCheckRollupEntry = {
	readonly name?: string;
	readonly status?: string;
	readonly state?: string;
	readonly conclusion?: string;
	readonly detailsUrl?: string;
	readonly targetUrl?: string;
	readonly workflowName?: string;
};

export type ActionsJob = {
	readonly id?: number | string;
	readonly name?: string;
	readonly html_url?: string;
	readonly status?: string;
	readonly conclusion?: string | null;
	readonly workflow_name?: string | null;
	readonly runner_name?: string | null;
	readonly runner_group_name?: string | null;
	readonly started_at?: string | null;
	readonly completed_at?: string | null;
};

export type ActionsCheckIds = {
	readonly runId: string;
	readonly jobId: string | null;
};

export type CheckRunMetadata = {
	readonly workflowName: string | null;
	readonly runId: string | null;
	readonly jobId: string | null;
	readonly runnerName: string | null;
	readonly runnerGroupName: string | null;
	readonly startedAt: Date | null;
	readonly completedAt: Date | null;
	readonly runUrl: string | null;
};

export const parseActionsCheckUrl = (
	url: string | null | undefined,
): ActionsCheckIds | null => {
	if (url === undefined || url === null || url.length === 0) return null;
	const run = /\/actions\/runs\/(\d+)/.exec(url);
	if (run === null || run[1] === undefined) return null;
	const job = /\/job\/(\d+)/.exec(url);
	return { runId: run[1], jobId: job?.[1] ?? null };
};

export const actionsJobsApiPath = (
	owner: string,
	repo: string,
	runId: string,
): string => `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`;

export const parseActionsJobsResponse = (
	stdout: string,
): ReadonlyArray<ActionsJob> => {
	try {
		const parsed = JSON.parse(stdout) as { jobs?: ReadonlyArray<ActionsJob> };
		return Array.isArray(parsed.jobs) ? parsed.jobs : [];
	} catch {
		return [];
	}
};

export const collectActionsRunIds = (
	rollup: ReadonlyArray<PrCheckRollupEntry>,
): ReadonlyArray<string> => {
	const ids = new Set<string>();
	for (const entry of rollup) {
		const idsFromUrl = parseActionsCheckUrl(
			entry.detailsUrl ?? entry.targetUrl,
		);
		if (idsFromUrl !== null) ids.add(idsFromUrl.runId);
	}
	return [...ids];
};

const parseDate = (value: string | null | undefined): Date | null => {
	if (typeof value !== "string" || value.length === 0) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
};

const jobIdString = (job: ActionsJob): string | null => {
	if (typeof job.id === "number") return String(job.id);
	if (typeof job.id === "string" && job.id.length > 0) return job.id;
	return null;
};

const findMatchingJob = (
	entry: PrCheckRollupEntry,
	ids: ActionsCheckIds | null,
	jobs: ReadonlyArray<ActionsJob>,
): ActionsJob | null => {
	if (ids?.jobId !== null && ids?.jobId !== undefined) {
		const byId = jobs.find((job) => jobIdString(job) === ids.jobId);
		if (byId !== undefined) return byId;
	}
	if (entry.name !== undefined && entry.name.length > 0) {
		const byName = jobs.find((job) => job.name === entry.name);
		if (byName !== undefined) return byName;
	}
	return null;
};

export const metadataForRollupEntry = (
	entry: PrCheckRollupEntry,
	jobsByRunId: ReadonlyMap<string, ReadonlyArray<ActionsJob>>,
): CheckRunMetadata => {
	const ids = parseActionsCheckUrl(entry.detailsUrl ?? entry.targetUrl);
	const jobs = ids === null ? [] : (jobsByRunId.get(ids.runId) ?? []);
	const job = findMatchingJob(entry, ids, jobs);
	return {
		workflowName: job?.workflow_name ?? entry.workflowName ?? null,
		runId: ids?.runId ?? null,
		jobId: ids?.jobId ?? (job !== null ? jobIdString(job) : null),
		runnerName: job?.runner_name ?? null,
		runnerGroupName: job?.runner_group_name ?? null,
		startedAt: parseDate(job?.started_at),
		completedAt: parseDate(job?.completed_at),
		runUrl:
			ids !== null
				? ((entry.detailsUrl ?? entry.targetUrl ?? null)?.replace(
						/\/job\/\d+(?:\?.*)?$/,
						"",
					) ?? null)
				: null,
	};
};
