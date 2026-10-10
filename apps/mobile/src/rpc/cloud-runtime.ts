import { cloudFailurePresentation } from "@zuse/client-runtime/cloud-failure-presentation";
import type { EnvironmentWakeIntent } from "@zuse/client-runtime/environment-runtime";
import type {
	CapabilityManifest,
	CloudWorkspace,
	CloudWorkspaceConnection,
} from "@zuse/contracts";
import { WORKSPACE_GATEWAY_PENDING_PROTOCOL } from "@zuse/contracts";
import { Effect } from "effect";
import {
	cloudCatalogAtom,
	cloudSummary,
	recordCloudCapabilities,
	updateCloudWorkspace,
} from "~/store/cloud-catalog";
import { appAtomRegistry } from "~/store/registry";

const flights = new Map<string, Promise<CloudWorkspaceConnection>>();
type PendingWake = {
	commandId: string;
	acknowledgments: Map<string, () => void>;
};
const wakeRequests = new Map<string, PendingWake>();
export const requestCloudRuntimeWake = (
	workspaceId: string,
	intent?: EnvironmentWakeIntent,
) => {
	let pending = wakeRequests.get(workspaceId);
	if (pending === undefined) {
		pending = {
			commandId: intent?.commandId ?? crypto.randomUUID(),
			acknowledgments: new Map(),
		};
		wakeRequests.set(workspaceId, pending);
	}
	if (intent !== undefined)
		pending.acknowledgments.set(intent.commandId, intent.acknowledge);
};

const acknowledgeCloudRuntimeWake = (
	workspaceId: string,
	expected = wakeRequests.get(workspaceId),
): void => {
	if (expected === undefined || wakeRequests.get(workspaceId) !== expected)
		return;
	wakeRequests.delete(workspaceId);
	for (const acknowledge of expected.acknowledgments.values()) acknowledge();
};

export const cloudRuntimeReady = (workspaceId: string): boolean => {
	const row = cloudSummary(workspaceId);
	return row?.state === "ready" && row.runtimeState === "online";
};

export const markCloudGatewayHealthy = (
	workspaceId: string,
	capabilities?: CapabilityManifest,
) => {
	acknowledgeCloudRuntimeWake(workspaceId);
	if (capabilities !== undefined)
		recordCloudCapabilities(workspaceId, capabilities);
};

let generation = 0;
export const resetCloudRuntime = (): void => {
	generation += 1;
	flights.clear();
	wakeRequests.clear();
};

export const connectCloudRuntime = (
	workspaceId: string,
): Promise<CloudWorkspaceConnection> => {
	const existing = flights.get(workspaceId);
	if (existing !== undefined) return existing;
	const epoch = generation;
	const accountId = appAtomRegistry.get(cloudCatalogAtom).accountId;
	const assertAccount = () => {
		if (
			epoch !== generation ||
			accountId === null ||
			appAtomRegistry.get(cloudCatalogAtom).accountId !== accountId ||
			cloudSummary(workspaceId) === undefined
		)
			throw new Error(
				"Cloud account changed. Reopen the chat from your account.",
			);
	};
	const operation = (async () => {
		const { cloudControlClient } = await import("./api-client");
		assertAccount();
		let row = await Effect.runPromise(
			cloudControlClient["cloud.workspaces.get"]({ workspaceId }),
		);
		const assertUsable = (workspace: CloudWorkspace) => {
			assertAccount();
			updateCloudWorkspace(workspace);
			const failure = cloudFailurePresentation({
				category: workspace.statusCode,
			});
			if (
				failure?.kind === "workspace-storage-unavailable" ||
				workspace.desiredState === "archived" ||
				workspace.desiredState === "deleted"
			)
				throw new Error(
					failure?.message ?? "This cloud workspace was archived or deleted.",
				);
		};
		assertUsable(row);
		if (row.desiredState === "paused" && !wakeRequests.has(workspaceId))
			throw new Error(
				"Cloud workspace is sleeping. Send a message to wake it.",
			);
		const wakeIntent = wakeRequests.get(workspaceId);
		if (
			wakeIntent !== undefined &&
			(row.state !== "ready" ||
				row.runtimeState !== "online" ||
				row.desiredState === "paused")
		) {
			row = await Effect.runPromise(
				cloudControlClient["cloud.workspaces.resume"]({
					workspaceId,
					commandId: wakeIntent.commandId,
				}),
			);
			assertUsable(row);
		}
		// Ready compute or an accepted wake consumes intent before ticket issuance.
		// Lost resume responses keep the same idempotent command for retry.
		acknowledgeCloudRuntimeWake(workspaceId, wakeIntent);
		if (row.state === "failed")
			throw new Error(
				cloudFailurePresentation({ category: row.statusCode })?.message ??
					`Cloud workspace could not start (${row.statusCode}).`,
			);
		let waitedForLegacyRuntime = false;
		let ticket = await Effect.runPromise(
			cloudControlClient["cloud.workspaces.connect"]({ workspaceId }),
		);
		const deadline = Date.now() + 120_000;
		while (ticket.protocol !== WORKSPACE_GATEWAY_PENDING_PROTOCOL) {
			assertUsable(row);
			if (row.state === "ready" && row.runtimeState === "online") break;
			if (row.state === "failed")
				throw new Error(
					cloudFailurePresentation({ category: row.statusCode })?.message ??
						`Cloud workspace could not start (${row.statusCode}).`,
				);
			if (Date.now() >= deadline)
				throw new Error(
					"Cloud workspace is still waking. Your accepted message remains queued.",
				);
			waitedForLegacyRuntime = true;
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			assertAccount();
			row = await Effect.runPromise(
				cloudControlClient["cloud.workspaces.get"]({ workspaceId }),
			);
		}
		if (waitedForLegacyRuntime)
			ticket = await Effect.runPromise(
				cloudControlClient["cloud.workspaces.connect"]({ workspaceId }),
			);
		assertAccount();
		return ticket;
	})().finally(() => {
		if (flights.get(workspaceId) === operation) flights.delete(workspaceId);
	});
	flights.set(workspaceId, operation);
	return operation;
};
