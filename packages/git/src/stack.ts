import { GitStackResult } from "@zuse/contracts";

export function parseStackView(output: string): GitStackResult | null {
	try {
		const value = JSON.parse(output);
		if (typeof value?.trunk !== "string" || !Array.isArray(value.branches))
			return null;
		if (
			!value.branches.every(
				(branch: unknown) =>
					branch !== null &&
					typeof branch === "object" &&
					"name" in branch &&
					typeof branch.name === "string" &&
					["isCurrent", "isMerged", "needsRebase"].every(
						(flag) =>
							!(flag in branch) ||
							typeof (branch as Record<string, unknown>)[flag] === "boolean",
					),
			)
		)
			return null;
		return GitStackResult.make({
			output: "",
			trunk: value.trunk,
			branches: value.branches.map(
				(branch: {
					name: string;
					isCurrent?: boolean;
					isMerged?: boolean;
					needsRebase?: boolean;
					pr?: { number?: unknown; url?: unknown; state?: unknown };
				}) => ({
					name: branch.name,
					isCurrent: branch.isCurrent === true,
					isMerged: branch.isMerged === true,
					needsRebase: branch.needsRebase === true,
					...(typeof branch.pr?.number === "number" &&
					Number.isSafeInteger(branch.pr.number) &&
					branch.pr.number > 0
						? {
								pr: {
									number: branch.pr.number,
									url: typeof branch.pr.url === "string" ? branch.pr.url : null,
									// gh-stack does not distinguish draft/open or reliably report closed PRs.
									state:
										branch.isMerged === true
											? ("merged" as const)
											: ("unknown" as const),
									isDraft: null,
								},
							}
						: {}),
				}),
			),
		});
	} catch {
		return null;
	}
}

/** One request for the known PR numbers; no per-branch subprocesses or list limits. */
export function stackPullRequestsQuery(
	stack: GitStackResult,
	owner: string,
	repo: string,
): string | null {
	const numbers = [
		...new Set(
			stack.branches.flatMap((branch) => (branch.pr ? [branch.pr.number] : [])),
		),
	];
	if (numbers.length === 0) return null;
	return `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { ${numbers.map((number) => `pr${number}: pullRequest(number: ${number}) { number title state isDraft }`).join(" ")} } }`;
}

export function withStackPullRequests(
	stack: GitStackResult,
	output: string,
): GitStackResult {
	try {
		const repository = JSON.parse(output)?.data?.repository;
		if (!repository || typeof repository !== "object") return stack;
		return GitStackResult.make({
			...stack,
			branches: stack.branches.map((branch) => {
				if (!branch.pr) return branch;
				const pr = repository[`pr${branch.pr.number}`];
				if (
					pr?.number !== branch.pr.number ||
					typeof pr.title !== "string" ||
					typeof pr.isDraft !== "boolean" ||
					!["OPEN", "CLOSED", "MERGED"].includes(pr.state)
				)
					return branch;
				const state =
					pr.state === "OPEN"
						? ("open" as const)
						: pr.state === "CLOSED"
							? ("closed" as const)
							: ("merged" as const);
				return {
					...branch,
					isMerged: state === "merged",
					pr: { ...branch.pr, title: pr.title, state, isDraft: pr.isDraft },
				};
			}),
		});
	} catch {
		return stack;
	}
}
