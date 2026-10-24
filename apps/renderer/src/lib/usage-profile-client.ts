import {
	CommandId,
	type EnvironmentId,
	type UsageBackupState,
	type UsageProfileSnapshot,
} from "@zuse/contracts";
import { getRendererClientBus } from "./session-timeline-client-bus.ts";

const dispatch = async <A>(
	environmentId: EnvironmentId,
	kind: string,
	payload: unknown,
) =>
	(
		await getRendererClientBus().dispatch<A>({
			commandId: CommandId.make(crypto.randomUUID()),
			environmentId,
			resource: null,
			kind,
			payload,
			retry: "never",
			createdAt: Date.now(),
		})
	).result;

export const loadUsageProfileSnapshot = (environmentId: EnvironmentId) =>
	dispatch<UsageProfileSnapshot>(environmentId, "usage.profile.snapshot", {
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
	});

export const loadUsageBackup = (environmentId: EnvironmentId) =>
	dispatch<UsageBackupState>(environmentId, "usage.backup.get", {});

export const updateUsageBackup = (
	environmentId: EnvironmentId,
	input: { readonly enabled: boolean; readonly deleteRemote?: boolean },
) => dispatch<UsageBackupState>(environmentId, "usage.backup.set", input);
