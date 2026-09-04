import { cloudFailurePresentation } from "@zuse/client-runtime/cloud-failure-presentation";
import { cloudGatewayCloseRecovery } from "@zuse/client-runtime/cloud-gateway-recovery";
import type {
	CapabilityManifest,
	CloudWorkspace,
	CloudWorkspaceConnection,
} from "@zuse/contracts";
import { Effect } from "effect";
import {
	cloudCatalogAtom,
	cloudSummary,
	recordCloudCapabilities,
	updateCloudWorkspace,
} from "~/store/cloud-catalog";
import { appAtomRegistry } from "~/store/registry";

const recoveries = new Map<string, string>();
const healthy = new Set<string>();
const abnormalCloses = new Map<string, number>();
const flights = new Map<string, Promise<CloudWorkspaceConnection>>();
const wakeRequests = new Set<string>();
export const requestCloudRuntimeWake = (workspaceId: string) => {
	wakeRequests.add(workspaceId);
};

export const cloudRuntimeReady = (workspaceId: string): boolean => {
	const row = cloudSummary(workspaceId);
	return row?.state === "ready" && row.runtimeState === "online";
};

export const recordCloudGatewayClose = (
	workspaceId: string,
	code: number,
): void => {
	const result = cloudGatewayCloseRecovery(
		code,
		healthy.has(workspaceId),
		abnormalCloses.get(workspaceId) ?? 0,
	);
	abnormalCloses.set(workspaceId, result.abnormalCloses);
	if (result.recover) {
		if (!recoveries.has(workspaceId))
			recoveries.set(workspaceId, crypto.randomUUID());
	}
};
export const markCloudGatewayHealthy = (
	workspaceId: string,
	capabilities?: CapabilityManifest,
) => {
	healthy.add(workspaceId);
	abnormalCloses.delete(workspaceId);
	wakeRequests.delete(workspaceId);
	if (capabilities !== undefined)
		recordCloudCapabilities(workspaceId, capabilities);
};

let generation = 0;
export const resetCloudRuntime = (): void => {
	generation += 1;
	recoveries.clear();
	healthy.clear();
	abnormalCloses.clear();
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
		const recovery = recoveries.get(workspaceId);
		if (
			row.state !== "ready" ||
			row.runtimeState !== "online" ||
			recovery !== undefined
		) {
			row = await Effect.runPromise(
				cloudControlClient["cloud.workspaces.resume"]({
					workspaceId,
					commandId: recovery ?? crypto.randomUUID(),
					...(recovery === undefined ? {} : { recoverRuntime: true }),
				}),
			);
		}
		const deadline = Date.now() + 120_000;
		while (true) {
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
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			assertAccount();
			row = await Effect.runPromise(
				cloudControlClient["cloud.workspaces.get"]({ workspaceId }),
			);
		}
		const ticket = await Effect.runPromise(
			cloudControlClient["cloud.workspaces.connect"]({ workspaceId }),
		);
		assertAccount();
		wakeRequests.delete(workspaceId);
		if (recoveries.get(workspaceId) === recovery)
			recoveries.delete(workspaceId);
		return ticket;
	})().finally(() => {
		if (flights.get(workspaceId) === operation) flights.delete(workspaceId);
	});
	flights.set(workspaceId, operation);
	return operation;
};
