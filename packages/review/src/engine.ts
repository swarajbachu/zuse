import {
	ReviewFinding,
	type ReviewResult,
	ReviewSnapshot,
} from "@zuse/contracts";
import { Schema } from "effect";
import { deduplicateFindings } from "./reconcile.ts";
import {
	createReviewTools,
	isRepositoryPath,
	validateLocation,
} from "./tools.ts";
import {
	DEFAULT_REVIEW_LIMITS,
	type ReviewChange,
	type ReviewEngineInput,
	type ReviewLimits,
} from "./types.ts";

const Investigation = Schema.Struct({
	findings: Schema.Array(ReviewFinding).check(Schema.isMaxLength(100)),
	reviewedPaths: Schema.Array(Schema.String).check(Schema.isMaxLength(50000)),
});

function resolveLimits(input: Partial<ReviewLimits> | undefined): ReviewLimits {
	const limits = { ...DEFAULT_REVIEW_LIMITS, ...input };
	for (const value of Object.values(limits))
		if (!Number.isSafeInteger(value) || value < 1)
			throw new Error("Invalid review limits");
	return limits;
}

function lineCount(change: ReviewChange): number {
	return [...change.addedLines, ...change.deletedLines].reduce((sum, range) => {
		if (
			!Number.isSafeInteger(range.start) ||
			!Number.isSafeInteger(range.end) ||
			range.start < 1 ||
			range.end < range.start
		)
			throw new Error("Invalid diff range");
		return sum + range.end - range.start + 1;
	}, 0);
}

/** Abort races uncooperative adapters too; adapters still must release their provider session on abort. */
async function interruptible<T>(
	operation: () => Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	signal.throwIfAborted();
	let abort: () => void = () => {};
	const stopped = new Promise<never>((_, reject) => {
		abort = () => reject(new Error("Review interrupted"));
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([operation(), stopped]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

export async function runReview(
	input: ReviewEngineInput,
): Promise<ReviewResult> {
	const snapshot = Schema.decodeUnknownSync(ReviewSnapshot)(input.snapshot);
	const sourceSnapshot = Schema.decodeUnknownSync(ReviewSnapshot)(
		input.source.snapshot,
	);
	for (const key of [
		"repositoryId",
		"baseRef",
		"baseSha",
		"headSha",
		"mergeBaseSha",
	] as const) {
		if (snapshot[key] !== sourceSnapshot[key])
			throw new Error("Review source snapshot mismatch");
	}
	const limits = resolveLimits(input.limits);
	const controller = new AbortController();
	const parentAbort = () => controller.abort();
	input.signal?.addEventListener("abort", parentAbort, { once: true });
	if (input.signal?.aborted) controller.abort();
	const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
	let contextLimited = input.source.contextLimited;
	const tools = createReviewTools(
		input.source,
		limits,
		controller.signal,
		() => {
			contextLimited = true;
		},
	);
	const eligible = input.source.changes.filter((change) => !change.excluded);
	const selected: ReviewChange[] = [];
	const reviewed = new Set<string>();
	const findings: ReviewFinding[] = [];
	let reason: string | undefined;
	try {
		controller.signal.throwIfAborted();
		let lines = 0;
		const paths = new Set<string>();
		for (const change of input.source.changes) {
			if (
				!isRepositoryPath(change.path) ||
				(change.previousPath && !isRepositoryPath(change.previousPath)) ||
				paths.has(change.path)
			)
				throw new Error("Invalid changed paths");
			paths.add(change.path);
		}
		for (const change of eligible) {
			const count = lineCount(change);
			if (
				selected.length >= limits.maxFiles ||
				lines + count > limits.maxChangedLines
			)
				continue;
			selected.push(change);
			lines += count;
		}
		if (selected.length > 0) {
			const raw = await interruptible(
				() =>
					input.investigate({
						snapshot,
						changes: selected,
						tools,
						signal: controller.signal,
					}),
				controller.signal,
			);
			const investigation = Schema.decodeUnknownSync(Investigation)(raw);
			for (const path of investigation.reviewedPaths)
				if (selected.some((change) => change.path === path)) reviewed.add(path);
			if (investigation.findings.length > limits.maxCandidates)
				reason = "candidate_limit";
			for (const candidate of deduplicateFindings(investigation.findings).slice(
				0,
				limits.maxCandidates,
			)) {
				try {
					validateLocation(candidate.location);
					const change = selected.find((entry) =>
						candidate.location.side === "RIGHT"
							? entry.path === candidate.location.path
							: (entry.previousPath ?? entry.path) === candidate.location.path,
					);
					if (!change || !reviewed.has(change.path)) continue;
					const ranges =
						candidate.location.side === "RIGHT"
							? change.addedLines
							: change.deletedLines;
					if (
						!ranges.some(
							(range) =>
								candidate.location.startLine >= range.start &&
								candidate.location.endLine <= range.end,
						)
					)
						continue;
					await interruptible(
						() => tools.read(candidate.location),
						controller.signal,
					);
					let validEvidence = true;
					for (const evidence of candidate.evidence) {
						const text = await interruptible(
							() => tools.read(evidence),
							controller.signal,
						);
						if (!evidence.quote.trim() || !text.includes(evidence.quote)) {
							validEvidence = false;
							break;
						}
					}
					if (!validEvidence) continue;
					const verdict = await interruptible(
						() =>
							input.verify({
								snapshot,
								candidate,
								tools,
								signal: controller.signal,
							}),
						controller.signal,
					);
					if (verdict === "confirmed") findings.push(candidate);
					else if (verdict !== "rejected") reason = "invalid_verification";
				} catch {
					controller.signal.throwIfAborted();
					reason = "verification_incomplete";
				}
			}
		}
	} catch {
		reason = controller.signal.aborted
			? input.signal?.aborted
				? "cancelled"
				: "deadline_exceeded"
			: "review_failed";
	} finally {
		clearTimeout(timer);
		input.signal?.removeEventListener("abort", parentAbort);
	}
	const unreviewedPaths = eligible
		.filter((change) => !reviewed.has(change.path))
		.map((change) => change.path);
	if (unreviewedPaths.length > 0) reason ??= "coverage_limit";
	if (contextLimited) reason ??= "context_limited";
	return {
		snapshot,
		status: reason ? "partial" : "completed",
		...(reason ? { reason } : {}),
		findings,
		coverage: {
			eligibleFiles: eligible.length,
			reviewedFiles: reviewed.size,
			excludedFiles: input.source.changes.length - eligible.length,
			unreviewedPaths,
			contextLimited,
		},
	};
}
