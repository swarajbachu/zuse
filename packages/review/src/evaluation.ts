export interface ReviewEvaluationCase {
	readonly id: string;
	readonly repository: string;
	readonly headSha: string;
	readonly split: "development" | "held-out";
	readonly label: "defect" | "clean";
	readonly provenance: "human-adjudicated" | "synthetic";
	readonly adjudicator: string;
	readonly highSeverityDefects: number;
}
export interface ReviewEvaluationObservation {
	readonly caseId: string;
	readonly published: number;
	readonly truePositives: number;
	readonly highSeverityFound: number;
	readonly completed: boolean;
	readonly durationMs: number;
	readonly settledComputeMicros: number;
}

/** Nominal 95% Wilson interval; observations within a repository may be correlated. */
function binomialInterval(successes: number, trials: number) {
	if (trials === 0) return null;
	const z = 1.959963984540054;
	const p = successes / trials;
	const denominator = 1 + (z * z) / trials;
	const center = (p + (z * z) / (2 * trials)) / denominator;
	const margin =
		(z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) /
		denominator;
	return {
		successes,
		trials,
		lower: Math.max(0, center - margin),
		upper: Math.min(1, center + margin),
	};
}

export function validateEvaluationCorpus(
	cases: readonly ReviewEvaluationCase[],
): readonly string[] {
	const errors: string[] = [];
	const ids = new Set<string>();
	const repositories = new Map<string, string>();
	for (const item of cases) {
		if (!item.id || ids.has(item.id))
			errors.push(`Duplicate or missing case ID: ${item.id}`);
		ids.add(item.id);
		if (
			!item.repository ||
			!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(item.headSha)
		)
			errors.push(`Invalid source identity: ${item.id}`);
		if (item.provenance !== "human-adjudicated" || !item.adjudicator.trim())
			errors.push(`Missing human adjudication: ${item.id}`);
		if (
			!Number.isSafeInteger(item.highSeverityDefects) ||
			item.highSeverityDefects < 0 ||
			(item.label === "clean" && item.highSeverityDefects !== 0)
		)
			errors.push(`Invalid defect count: ${item.id}`);
		const prior = repositories.get(item.repository);
		if (prior && prior !== item.split)
			errors.push(`Repository leaks across splits: ${item.repository}`);
		repositories.set(item.repository, item.split);
	}
	if (
		cases.filter((item) => item.split === "held-out" && item.label === "defect")
			.length < 50
	)
		errors.push("At least 50 held-out defect cases required");
	if (
		cases.filter((item) => item.split === "held-out" && item.label === "clean")
			.length < 50
	)
		errors.push("At least 50 held-out clean cases required");
	return [...new Set(errors)];
}

export function evaluateReviewRelease(
	cases: readonly ReviewEvaluationCase[],
	observations: readonly ReviewEvaluationObservation[],
) {
	const errors = [...validateEvaluationCorpus(cases)];
	const known = new Map(cases.map((item) => [item.id, item]));
	const seen = new Set<string>();
	let published = 0;
	let truePositives = 0;
	let severe = 0;
	let severeFound = 0;
	let clean = 0;
	let cleanFalsePositive = 0;
	let cost = 0;
	const durations: number[] = [];
	for (const observation of observations) {
		const item = known.get(observation.caseId);
		if (!item || seen.has(observation.caseId)) {
			errors.push("Unknown or duplicate observation");
			continue;
		}
		seen.add(observation.caseId);
		if (item.split !== "held-out") continue;
		const counts = [
			observation.published,
			observation.truePositives,
			observation.highSeverityFound,
			observation.durationMs,
			observation.settledComputeMicros,
		];
		if (
			counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
			observation.truePositives > observation.published ||
			observation.highSeverityFound > item.highSeverityDefects ||
			observation.highSeverityFound > observation.truePositives ||
			(item.label === "clean" && observation.truePositives !== 0)
		) {
			errors.push(`Invalid observation: ${item.id}`);
			continue;
		}
		if (!observation.completed) errors.push(`Incomplete review: ${item.id}`);
		published += observation.published;
		truePositives += observation.truePositives;
		severe += item.highSeverityDefects;
		severeFound += observation.highSeverityFound;
		if (item.label === "clean") {
			clean++;
			if (observation.published > 0) cleanFalsePositive++;
		}
		cost += observation.settledComputeMicros;
		durations.push(observation.durationMs);
	}
	for (const item of cases)
		if (item.split === "held-out" && !seen.has(item.id))
			errors.push(`Missing observation: ${item.id}`);
	const precision = published === 0 ? null : truePositives / published;
	const highSeverityRecall = severe === 0 ? null : severeFound / severe;
	const cleanPrFalsePositiveRate =
		clean === 0 ? null : cleanFalsePositive / clean;
	if (precision === null || precision < 0.85)
		errors.push("Precision below 85% or unmeasured");
	if (highSeverityRecall === null || highSeverityRecall < 0.6)
		errors.push("High severity recall below 60% or unmeasured");
	if (cleanPrFalsePositiveRate === null || cleanPrFalsePositiveRate > 0.1)
		errors.push("Clean PR false positive rate above 10% or unmeasured");
	durations.sort((a, b) => a - b);
	return {
		passed: errors.length === 0,
		errors,
		metrics: {
			precision,
			highSeverityRecall,
			cleanPrFalsePositiveRate,
			uncertainty: {
				method: "Wilson 95% nominal binomial interval" as const,
				limitation:
					"Findings and PRs within a repository can be correlated; these intervals do not replace a repository-clustered analysis.",
				precision: binomialInterval(truePositives, published),
				highSeverityRecall: binomialInterval(severeFound, severe),
				cleanPrFalsePositiveRate: binomialInterval(cleanFalsePositive, clean),
			},
			publishedFindings: published,
			heldOutCases: durations.length,
			totalSettledComputeMicros: cost,
			p95DurationMs:
				durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? null,
		},
	};
}
