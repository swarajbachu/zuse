import { createHash } from "node:crypto";
import type { ReviewFinding } from "@zuse/contracts";

/** Location lines are intentionally excluded so a moved finding retains its identity. */
export function findingIdentity(finding: ReviewFinding): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				finding.location.path,
				finding.trigger.trim().replace(/\s+/gu, " "),
				finding.consequence.trim().replace(/\s+/gu, " "),
				finding.evidence
					.map((item) => [item.path, item.quote.trim().replace(/\s+/gu, " ")])
					.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
			]),
		)
		.digest("hex");
}

export function prioritizeFindings(
	findings: readonly ReviewFinding[],
): readonly ReviewFinding[] {
	const rank = { critical: 0, high: 1, medium: 2 };
	return [...findings].sort(
		(a, b) =>
			rank[a.severity] - rank[b.severity] ||
			a.location.path.localeCompare(b.location.path) ||
			a.location.startLine - b.location.startLine,
	);
}

export function deduplicateFindings(
	findings: readonly ReviewFinding[],
): readonly ReviewFinding[] {
	const unique = new Map<string, ReviewFinding>();
	for (const finding of prioritizeFindings(findings)) {
		const id = findingIdentity(finding);
		if (!unique.has(id)) unique.set(id, { ...finding, id });
	}
	return [...unique.values()];
}

/** Missing findings remain unresolved; only an explicit full recheck may resolve a thread. */
export function reconcileFindings(
	previous: readonly ReviewFinding[],
	current: readonly ReviewFinding[],
) {
	const old = new Map(
		previous.map((finding) => [findingIdentity(finding), finding]),
	);
	const findings = deduplicateFindings(current);
	const present = new Set(findings.map((finding) => finding.id));
	return {
		added: findings.filter((finding) => !old.has(finding.id)),
		retained: findings.filter((finding) => old.has(finding.id)),
		unverifiedPrevious: [...old]
			.filter(([id]) => !present.has(id))
			.map(([, finding]) => finding),
	};
}
