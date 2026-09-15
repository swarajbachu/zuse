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
					typeof branch.name === "string",
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
				}) => ({
					name: branch.name,
					isCurrent: branch.isCurrent === true,
					isMerged: branch.isMerged === true,
					needsRebase: branch.needsRebase === true,
				}),
			),
		});
	} catch {
		return null;
	}
}
