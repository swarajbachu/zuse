import type { OrganizationRole } from "@zuse/contracts";
import { Effect } from "effect";
import { mobileReleaseFeatures } from "~/lib/release-features";
import { organizationControlClientForAccount } from "~/rpc/api-client";
import { cloudCatalogAtom, cloudWorkspaceSnapshot } from "./cloud-catalog";
import { appAtomRegistry } from "./registry";

/** A retained menu or confirmation must never act in a newly selected workspace. */
export const createOrganizationMembersController = () => {
	const snapshot = cloudWorkspaceSnapshot();
	const scope = snapshot.scope;
	const membership = () =>
		scope.kind === "organization"
			? appAtomRegistry
					.get(cloudCatalogAtom)
					.organizations.find((entry) => entry.id === scope.organizationId)
			: undefined;
	const isCurrent = () =>
		mobileReleaseFeatures.organizationWorkspaces &&
		snapshot.accountId !== null &&
		snapshot.isCurrent() &&
		membership() !== undefined;
	const assertCurrent = (admin = false) => {
		if (!isCurrent() || (admin && membership()?.role !== "admin"))
			throw new Error("Workspace access changed. Reopen Members.");
	};
	assertCurrent();
	if (scope.kind !== "organization") throw new Error("Select an organization.");
	const organizationId = scope.organizationId;
	const client = organizationControlClientForAccount();
	const run = async <A, E>(
		request: () => Effect.Effect<A, E>,
		admin = false,
	) => {
		assertCurrent(admin);
		const result = await Effect.runPromise(request());
		assertCurrent(admin);
		return result;
	};
	return {
		isCurrent,
		load: async () => {
			const details = await run(() =>
				client["organizations.get"]({ organizationId }),
			);
			if (details.organization.id !== organizationId)
				throw new Error("Unexpected organization. Refresh Members.");
			return details;
		},
		invite: (email: string, role: OrganizationRole) =>
			run(
				() => client["organizations.invite"]({ organizationId, email, role }),
				true,
			),
		setRole: (memberId: string, role: OrganizationRole) =>
			run(
				() =>
					client["organizations.setRole"]({ organizationId, memberId, role }),
				true,
			),
		remove: (memberId: string) =>
			run(
				() =>
					client["organizations.removeMember"]({ organizationId, memberId }),
				true,
			),
		revoke: (invitationId: string) =>
			run(
				() =>
					client["organizations.revokeInvite"]({
						organizationId,
						invitationId,
					}),
				true,
			),
	};
};
