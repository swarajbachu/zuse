export const buildCreateReviewCommentArgs = ({
	owner,
	repo,
	pullNumber,
	headSha,
	path,
	line,
	side,
	body,
}: {
	readonly owner: string;
	readonly repo: string;
	readonly pullNumber: number;
	readonly headSha: string;
	readonly path: string;
	readonly line: number;
	readonly side: "additions" | "deletions";
	readonly body: string;
}): ReadonlyArray<string> => [
	"api",
	"--method",
	"POST",
	`repos/${owner}/${repo}/pulls/${pullNumber}/comments`,
	"-f",
	`body=${body}`,
	"-f",
	`commit_id=${headSha}`,
	"-f",
	`path=${path}`,
	"-F",
	`line=${line}`,
	"-f",
	`side=${side === "deletions" ? "LEFT" : "RIGHT"}`,
];

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
