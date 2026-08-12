import type { CloudChatSummary } from "@zuse/contracts";

export type CloudTopBarContext = {
	readonly repositoryLabel: string;
	readonly owner: string | null;
	readonly branch: string;
};

export const cloudTopBarContext = (
	summary: CloudChatSummary | null,
): CloudTopBarContext | null => {
	if (summary === null) return null;
	const identityParts = summary.repositoryIdentity
		.split("/")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	const repositoryFromIdentity = identityParts.at(-1) ?? null;
	const repositoryLabel =
		summary.repositoryDisplayName.trim() || repositoryFromIdentity;
	if (repositoryLabel === null || summary.branch.trim().length === 0)
		return null;
	return {
		repositoryLabel,
		owner: identityParts.length >= 2 ? (identityParts.at(-2) ?? null) : null,
		branch: summary.branch,
	};
};
