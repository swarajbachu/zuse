import { Clock, Effect } from "effect";
import {
	queueCloudWorkspaceResume,
	requireCloudBillingCapacity,
	requireCloudWorkspaceEntitlement,
} from "./cloud-workspace-routes.ts";
import {
	CloudWorkspaceStore,
	destructiveMailboxLifecycle,
} from "./cloud-workspace-store.ts";

/** Called only when a Durable Object has pending automation work. */
export const wakeAutomationWorkspace = Effect.fn("wakeAutomationWorkspace")(
	function* (workspaceId: string, accountId: string) {
		const now = yield* Clock.currentTimeMillis;
		const store = yield* CloudWorkspaceStore;
		const workspace = yield* store.getWorkspace(workspaceId);
		if (
			!workspace ||
			workspace.accountId !== accountId ||
			destructiveMailboxLifecycle(workspace) !== null
		)
			return false;
		if (workspace.state !== "paused") return true;
		yield* requireCloudWorkspaceEntitlement(accountId, now);
		yield* requireCloudBillingCapacity(accountId, now);
		yield* queueCloudWorkspaceResume(
			workspace,
			`automation-resume:${workspaceId}:${workspace.revision}`,
			now,
		);
		return true;
	},
);
