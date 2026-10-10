import {
	ApiPaths,
	WORKSPACE_SCOPE_HEADER,
	type WorkspaceScope,
	WorkspaceScopeHeader,
} from "@zuse/contracts";
import { Effect, Schema } from "effect";
import { badRequest, forbidden } from "./errors.ts";

export const workspaceScopeForOwner = (ownerId: string): WorkspaceScope =>
	ownerId.startsWith("organization:")
		? { kind: "organization", organizationId: ownerId.slice(13) }
		: { kind: "personal" };

/** Explicit rollout allowlist; expanding it requires scoped authorization in the handler. */
export const workspaceAccessForPath = (
	path: string,
	method?: string,
): "billing" | "administration" | "content" | undefined => {
	if (
		method === "POST" &&
		(path === "/v1/plugins" || path === "/v1/plugins/tools")
	)
		return "content";
	if (/^\/v1\/plugins\/[^/]+\/mcp$/.test(path)) return "content";
	if (
		(method === "GET" && path === ApiPaths.cloudGithub) ||
		(method === "POST" && path === ApiPaths.cloudGithubInstall)
	)
		return "content";
	if (
		path === ApiPaths.cloudProviderConnections ||
		path === ApiPaths.cloudSnapshotImport
	)
		return "administration";
	if (path === ApiPaths.cloudSettings) {
		if (method === "GET") return "content";
		if (method === "PUT") return "administration";
		return undefined;
	}
	if (
		method === "GET" &&
		(path === ApiPaths.cloudProviders ||
			path === ApiPaths.cloudProjects ||
			path === ApiPaths.cloudAuth ||
			path === ApiPaths.cloudAccountImage)
	)
		return "content";
	if (path === ApiPaths.cloudSharingDefaults)
		return method === "GET" ? "content" : "administration";
	if (path === ApiPaths.cloudWorkspaces && method === "POST") return "content";
	if (
		(method === "GET" &&
			/^\/v1\/cloud\/workspaces\/[^/]+\/(?:data-key|commands\/[^/]+)$/u.test(
				path,
			)) ||
		(method === "POST" &&
			/^\/v1\/cloud\/workspaces\/[^/]+\/(?:commands|pause|resume|restart|update|archive|unarchive|delete)$/u.test(
				path,
			)) ||
		(method === "DELETE" &&
			/^\/v1\/cloud\/workspaces\/[^/]+\/commands\/(?!watch$)[^/]+$/u.test(path))
	)
		return "content";
	if (
		method === "GET" &&
		(path === ApiPaths.cloudChats || path === ApiPaths.cloudChatChanges)
	)
		return "content";
	if (
		(method === "GET" || method === "PUT") &&
		/^\/v1\/cloud\/workspaces\/[^/]+\/sharing$/u.test(path)
	)
		return "content";
	if (
		(method === "GET" &&
			(path === ApiPaths.cloudWorkspaces ||
				/^\/v1\/cloud\/workspaces\/[^/]+(?:\/sessions\/[^/]+\/transcript-(?:checkpoint|message-page))?$/u.test(
					path,
				))) ||
		(method === "POST" &&
			/^\/v1\/cloud\/workspaces\/[^/]+\/gateway\/ticket$/u.test(path))
	)
		return "content";
	if (
		[
			ApiPaths.billingCheckout,
			ApiPaths.billingPortal,
			ApiPaths.billingPrepaid,
			ApiPaths.billingPrepaidCheckout,
			ApiPaths.billingEntitlements,
			ApiPaths.cloudBillingSummary,
			ApiPaths.cloudBillingUsage,
			ApiPaths.cloudBillingCap,
		].some((candidate) => candidate === path)
	)
		return "billing";
	if (
		path === ApiPaths.cloudProviders ||
		path === ApiPaths.cloudAccountImage ||
		path === ApiPaths.cloudAccountImageBuild ||
		path === ApiPaths.cloudAccountImageDelete ||
		path === ApiPaths.cloudProjects ||
		path.startsWith(`${ApiPaths.cloudProjects}/`) ||
		path === ApiPaths.cloudAuth ||
		path.startsWith(`${ApiPaths.cloudAuth}/`) ||
		(path !== ApiPaths.cloudGithubCallback &&
			path !== ApiPaths.cloudGithubWebhook &&
			(path === ApiPaths.cloudGithub ||
				path.startsWith(`${ApiPaths.cloudGithub}/`)))
	)
		return "administration";
	return undefined;
};

export const requestWorkspaceScope = Effect.fn("requestWorkspaceScope")(
	function* (request: Request) {
		const header = request.headers.get(WORKSPACE_SCOPE_HEADER);
		if (header === null) return { kind: "personal" } as const;
		const value = yield* Schema.decodeUnknownEffect(WorkspaceScopeHeader)(
			header,
		).pipe(Effect.mapError(() => badRequest("invalid_workspace_scope")));
		const scope: WorkspaceScope =
			value === "personal"
				? { kind: "personal" }
				: { kind: "organization", organizationId: value.slice(13) };
		return scope;
	},
);

/** Unmigrated endpoints must reject organization scope, never fall back to Personal. */
export const requirePersonalWorkspace = Effect.fn("requirePersonalWorkspace")(
	function* (request: Request) {
		const scope = yield* requestWorkspaceScope(request);
		if (scope.kind !== "personal")
			return yield* forbidden("workspace_scope_not_supported");
	},
);
