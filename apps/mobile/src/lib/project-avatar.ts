import type { GitOriginInfo } from "@zuse/contracts";

import { githubOwnerAvatarUrl } from "./display-names";

export const resolveProjectAvatarUrl = (
	origin: GitOriginInfo | null | undefined,
	provisionalUrl: string | null,
): string | null =>
	origin === undefined || origin === null
		? provisionalUrl
		: githubOwnerAvatarUrl(origin.owner);
