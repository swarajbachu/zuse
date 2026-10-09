export const buildCreateReviewCommentBody = ({
	headSha,
	path,
	line,
	side,
	body,
}: {
	readonly headSha: string;
	readonly path: string;
	readonly line: number;
	readonly side: "additions" | "deletions";
	readonly body: string;
}) => ({
	body,
	commit_id: headSha,
	path,
	line,
	side: side === "deletions" ? "LEFT" : "RIGHT",
});

export const parseReviewIdentity = (
	output: string,
): { readonly name: string; readonly avatarUrl: string | null } | null => {
	try {
		const user = JSON.parse(output) as {
			readonly login?: string;
			readonly name?: string | null;
			readonly avatar_url?: string | null;
		};
		const name = user.name?.trim() || user.login?.trim() || "";
		return name.length === 0
			? null
			: { name, avatarUrl: user.avatar_url ?? null };
	} catch {
		return null;
	}
};
