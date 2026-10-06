import {
	OrganizationDetails,
	OrganizationDomainSettings,
	OrganizationGithubSettings,
} from "@zuse/contracts";
import { Schema } from "effect";
import {
	peekControlPlaneCache,
	runCachedRead,
} from "./control-plane-client.ts";
import { runOrganizations } from "./organization-client.ts";

/**
 * Members settings open from the last known snapshot (memory, then storage)
 * and revalidate in the background, so reopening them never blocks on the API.
 */
const keys = {
	details: (organizationId: string) =>
		`organizations:details:${organizationId}`,
	autoJoin: (organizationId: string) =>
		`organizations:auto-join:${organizationId}`,
};

const decodeDetails = Schema.decodeUnknownSync(OrganizationDetails);
export const OrganizationAutoJoinSettings = Schema.Struct({
	github: OrganizationGithubSettings,
	domains: OrganizationDomainSettings,
});
export type OrganizationAutoJoinSettings =
	typeof OrganizationAutoJoinSettings.Type;
const decodeAutoJoin = Schema.decodeUnknownSync(OrganizationAutoJoinSettings);

export const peekOrganizationDetails = (organizationId: string) =>
	peekControlPlaneCache(keys.details(organizationId), decodeDetails, "account");

export const loadOrganizationDetails = (
	organizationId: string,
	refresh = false,
) =>
	runCachedRead(
		keys.details(organizationId),
		() =>
			runOrganizations((client) =>
				client["organizations.get"]({ organizationId }),
			),
		{ refresh, decode: decodeDetails, scope: "account" },
	);

export const peekOrganizationAutoJoin = (organizationId: string) =>
	peekControlPlaneCache(
		keys.autoJoin(organizationId),
		decodeAutoJoin,
		"account",
	);

export const loadOrganizationAutoJoin = (
	organizationId: string,
	refresh = false,
) =>
	runCachedRead(
		keys.autoJoin(organizationId),
		async () => {
			const [github, domains] = await Promise.all([
				runOrganizations((client) =>
					client["organizations.githubSettings"]({ organizationId }),
				),
				runOrganizations((client) =>
					client["organizations.domains"]({ organizationId }),
				),
			]);
			return { github, domains };
		},
		{ refresh, decode: decodeAutoJoin, scope: "account" },
	);
