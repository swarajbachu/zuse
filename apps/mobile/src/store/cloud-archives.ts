import { workspaceScopeKey } from "@zuse/client-runtime/environment-scope";
import { Effect } from "effect";
import { cloudControlClientForWorkspace } from "~/rpc/api-client";
import { cloudWorkspaceSnapshot } from "./cloud-catalog";

/** Archived rows are not added to the active-chat catalog just to authorize an action. */
export const createCloudArchiveController = () => {
	const snapshot = cloudWorkspaceSnapshot();
	const assertCurrent = () => {
		if (snapshot.accountId === null || !snapshot.isCurrent())
			throw new Error("Workspace changed. Reopen archived chats.");
	};
	assertCurrent();
	const client = cloudControlClientForWorkspace(snapshot.scope);
	let knownIds = new Set<string>();
	let revision = 0;
	const mutate = async (workspaceId: string, action: "restore" | "delete") => {
		assertCurrent();
		if (!knownIds.has(workspaceId))
			throw new Error("Refresh archived chats before changing this chat.");
		await Effect.runPromise(
			action === "restore"
				? client["cloud.workspaces.unarchive"]({ workspaceId })
				: client["cloud.workspaces.delete"]({ workspaceId }),
		);
		assertCurrent();
		revision++;
		knownIds.delete(workspaceId);
	};
	return {
		list: async () => {
			assertCurrent();
			const request = ++revision;
			const result = await Effect.runPromise(
				client["cloud.chats.list"]({ scope: "archived" }),
			);
			assertCurrent();
			if (request !== revision)
				throw new Error("Archived chats changed. Refresh to retry.");
			if (
				result.chats.some(
					(row) =>
						workspaceScopeKey(row.workspaceScope ?? { kind: "personal" }) !==
						workspaceScopeKey(snapshot.scope),
				)
			) {
				knownIds.clear();
				throw new Error("Archive returned a different workspace.");
			}
			knownIds = new Set(result.chats.map((row) => row.workspaceId));
			return result.chats;
		},
		restore: (workspaceId: string) => mutate(workspaceId, "restore"),
		delete: (workspaceId: string) => mutate(workspaceId, "delete"),
	};
};
