export const PR_AVATARS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$oid:GitObjectID!,$endCursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){author{avatarUrl(size:40)}}
    object(oid:$oid){... on Commit{statusCheckRollup{contexts(first:100,after:$endCursor){
      nodes{... on CheckRun{name detailsUrl checkSuite{app{name logoUrl(size:40)}}}}
      pageInfo{hasNextPage endCursor}
    }}}}
  }
}`;

export type PrAvatars = {
	authorAvatarUrl: string | null;
	checks: Map<string, { name: string; avatarUrl: string }>;
};
export const checkAvatarKey = (name: string, url: string | null): string =>
	JSON.stringify([name, url]);

export function parsePrAvatars(output: string): PrAvatars {
	const result: PrAvatars = { authorAvatarUrl: null, checks: new Map() };
	try {
		const pages = JSON.parse(output);
		if (!Array.isArray(pages)) return result;
		for (const page of pages) {
			const repo = page?.data?.repository;
			const avatar = repo?.pullRequest?.author?.avatarUrl;
			if (typeof avatar === "string") result.authorAvatarUrl = avatar;
			const nodes = repo?.object?.statusCheckRollup?.contexts?.nodes;
			if (!Array.isArray(nodes)) continue;
			for (const check of nodes) {
				const app = check?.checkSuite?.app;
				if (
					typeof check?.name !== "string" ||
					typeof app?.name !== "string" ||
					typeof app?.logoUrl !== "string"
				)
					continue;
				result.checks.set(
					checkAvatarKey(
						check.name,
						typeof check.detailsUrl === "string" ? check.detailsUrl : null,
					),
					{ name: app.name, avatarUrl: app.logoUrl },
				);
			}
		}
	} catch {
		/* Optional artwork must not hide PR feedback or checks. */
	}
	return result;
}
