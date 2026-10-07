import { parseCloudChatRoute } from "@zuse/client-runtime/environment-scope";
import { CloudWorkspaceOpError, WorkspaceScope } from "@zuse/contracts";
import { Effect, Schema } from "effect";
import { getCloudControlClient } from "./cloud-control-client.ts";
import { openCloudChat } from "./cloud-workspaces.ts";
import {
	loadOrganizationWorkspaces,
	organizationWorkspacesAvailable,
} from "./organization-workspaces.ts";
import {
	assertRendererAccountCurrent,
	rendererAccountSnapshot,
} from "./renderer-account.ts";
import {
	assertRendererWorkspaceCurrent,
	rendererWorkspaceSnapshot,
	selectRendererWorkspace,
	workspaceScopeKey,
} from "./renderer-workspace.ts";

/** Resolve through the authorized catalog before changing any visible selection. */
export const openCloudChatLink = async (pathname: string): Promise<void> => {
	const route = parseCloudChatRoute(pathname);
	if (route === null) throw new Error("chat_link_unavailable");
	const scope = Schema.decodeUnknownSync(WorkspaceScope)(route.scope);
	const account = rendererAccountSnapshot();
	const previous = rendererWorkspaceSnapshot();
	if (!account.subject) throw new Error("chat_link_unavailable");
	if (scope.kind === "organization") {
		const organizations = await loadOrganizationWorkspaces(true);
		if (!organizationWorkspacesAvailable())
			throw new Error("chat_link_unavailable");
		assertRendererAccountCurrent(account);
		assertRendererWorkspaceCurrent(previous);
		if (
			!organizations.some(
				(organization) =>
					organization.id === scope.organizationId &&
					(organization.role === "admin" || organization.role === "member"),
			)
		)
			throw new Error("chat_link_unavailable");
	}
	const client = await getCloudControlClient(scope);
	assertRendererAccountCurrent(account);
	assertRendererWorkspaceCurrent(previous);
	const result = await Effect.runPromise(
		client["cloud.chats.list"]({ scope: "all" }).pipe(
			Effect.mapError((error: unknown) =>
				error instanceof CloudWorkspaceOpError &&
				(error.code === "not-allowed" || error.code === "not-found")
					? new Error("chat_link_unavailable")
					: error,
			),
		),
	);
	assertRendererAccountCurrent(account);
	assertRendererWorkspaceCurrent(previous);
	const summary = result.chats.find(
		(chat) =>
			chat.workspaceId === route.workspaceId &&
			workspaceScopeKey(chat.workspaceScope ?? { kind: "personal" }) ===
				workspaceScopeKey(scope),
	);
	if (summary === undefined) throw new Error("chat_link_unavailable");
	selectRendererWorkspace(scope);
	await openCloudChat(summary);
};
