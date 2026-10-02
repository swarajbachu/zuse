import {
	cloudChatRoute,
	workspaceScopeKey,
} from "@zuse/client-runtime/environment-scope";
import type { ChatSharingUpdate } from "@zuse/contracts";
import { HOSTED_APP_URL } from "@zuse/contracts/deployment";
import { Effect } from "effect";
import { mobileReleaseFeatures } from "~/lib/release-features";
import {
	cloudControlClientForWorkspace,
	organizationControlClientForAccount,
} from "~/rpc/api-client";
import {
	cloudCatalogAtom,
	cloudSummary,
	cloudWorkspaceSnapshot,
} from "./cloud-catalog";
import { appAtomRegistry } from "./registry";

export const createCloudChatSharingController = (workspaceId: string) => {
	const snapshot = cloudWorkspaceSnapshot();
	const scope = snapshot.scope;
	const isCurrent = () => {
		const summary = cloudSummary(workspaceId);
		return (
			mobileReleaseFeatures.organizationWorkspaces &&
			snapshot.accountId !== null &&
			snapshot.isCurrent() &&
			scope.kind === "organization" &&
			summary?.workspaceScope !== undefined &&
			workspaceScopeKey(summary.workspaceScope) === workspaceScopeKey(scope) &&
			appAtomRegistry
				.get(cloudCatalogAtom)
				.organizations.some(
					(entry) =>
						entry.id === scope.organizationId && entry.role !== "billing",
				)
		);
	};
	const assertCurrent = () => {
		if (!isCurrent()) throw new Error("Chat access changed. Reopen Share.");
	};
	assertCurrent();
	if (scope.kind !== "organization")
		throw new Error("Select an organization chat.");
	const client = cloudControlClientForWorkspace(scope);
	const organizations = organizationControlClientForAccount();
	const run = async <A, E>(request: () => Effect.Effect<A, E>) => {
		assertCurrent();
		const result = await Effect.runPromise(request());
		assertCurrent();
		return result;
	};
	return {
		isCurrent,
		load: async () => {
			const [sharing, organization] = await Promise.all([
				run(() => client["cloud.sharing.get"]({ workspaceId })),
				run(() =>
					organizations["organizations.get"]({
						organizationId: scope.organizationId,
					}),
				),
			]);
			assertCurrent();
			if (organization.organization.id !== scope.organizationId)
				throw new Error("Unexpected organization.");
			return { sharing, organization };
		},
		save: (input: ChatSharingUpdate) =>
			run(() => client["cloud.sharing.update"]({ ...input, workspaceId })),
		link: () => {
			assertCurrent();
			return new URL(
				cloudChatRoute({ scope, workspaceId }),
				HOSTED_APP_URL,
			).toString();
		},
	};
};
