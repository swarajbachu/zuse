import {
	parseCloudChatRoute,
	workspaceScopeKey,
} from "@zuse/client-runtime/environment-scope";
import { WorkspaceScope } from "@zuse/contracts";
import { Effect, Schema } from "effect";
import { mobileReleaseFeatures } from "~/lib/release-features";
import { cloudControlClientForWorkspace } from "~/rpc/api-client";
import {
	cloudCatalogAtom,
	cloudCatalogGeneration,
	cloudConnectionKey,
	refreshCloudOrganizations,
	registerCloudSummary,
	setCloudCatalogWorkspace,
} from "./cloud-catalog";
import { appAtomRegistry } from "./registry";

/** The URL is a locator, not a grant. Do not select or connect until access is verified. */
export const resolveMobileCloudChatLink = async (
	pathname: string,
	signal?: AbortSignal,
) => {
	const route = parseCloudChatRoute(pathname);
	if (route === null) throw new Error("This chat link is invalid.");
	const scope = Schema.decodeUnknownSync(WorkspaceScope)(route.scope);
	const epoch = cloudCatalogGeneration();
	if (appAtomRegistry.get(cloudCatalogAtom).accountId === null)
		throw new Error("Sign in to open this chat.");
	const assertCurrent = () => {
		if (signal?.aborted || epoch !== cloudCatalogGeneration())
			throw new Error("Workspace changed. Open the link again.");
	};
	assertCurrent();
	if (scope.kind === "organization") {
		if (!mobileReleaseFeatures.organizationWorkspaces)
			throw new Error("Organization chat links are not enabled in this build.");
		const organizations = await refreshCloudOrganizations();
		assertCurrent();
		if (
			!organizations.some(
				(organization) =>
					organization.id === scope.organizationId &&
					organization.role !== "billing",
			)
		)
			throw new Error("This chat is unavailable or you do not have access.");
	}
	const result = await Effect.runPromise(
		cloudControlClientForWorkspace(scope)["cloud.chats.list"]({ scope: "all" }),
	);
	assertCurrent();
	const summary = result.chats.find(
		(chat) =>
			chat.workspaceId === route.workspaceId &&
			workspaceScopeKey(chat.workspaceScope ?? { kind: "personal" }) ===
				workspaceScopeKey(scope),
	);
	if (summary === undefined)
		throw new Error("This chat is unavailable or you do not have access.");
	setCloudCatalogWorkspace(scope);
	registerCloudSummary(summary);
	return `/c/${encodeURIComponent(cloudConnectionKey(summary.workspaceId))}/session/${encodeURIComponent(summary.activeSessionId ?? summary.initialSessionId)}` as const;
};
