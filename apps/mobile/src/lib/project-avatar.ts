import type { GitOriginInfo } from "@zuse/contracts";

import { githubOwnerAvatarUrl } from "./display-names";

export const resolveProjectAvatarUrl = (
	origin: GitOriginInfo | null | undefined,
	provisionalUrl: string | null,
): string | null =>
	origin === undefined || origin === null
		? provisionalUrl
		: githubOwnerAvatarUrl(origin.owner);

export const shouldHydrateProjectAvatar = (options: {
	readonly connectionStatus: string | undefined;
	readonly originResolved: boolean;
	readonly loading: boolean;
	readonly generation?: number;
	readonly attemptedGeneration?: number;
}): boolean =>
	options.connectionStatus === "connected" &&
	!options.originResolved &&
	!options.loading &&
	(options.generation === undefined ||
		options.generation !== options.attemptedGeneration);
