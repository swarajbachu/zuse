import { CommandId, EnvironmentId, type MachineSshKey } from "@zuse/contracts";

import { type CloudSshPrepared, getAppBridge } from "./bridge.ts";
import { runControlPlane } from "./control-plane-client.ts";
import {
	dispatchEnvironmentShellCommand,
	retainEnvironmentShell,
} from "./environment-shell-client-bus.ts";
import { getRendererClientBus } from "./session-timeline-client-bus.ts";

/**
 * Orchestrates SSH access to a cloud workspace:
 * 1. `cloud.workspaces.sshAccess` (relay) stages a hashed bridge ticket in the
 *    sandbox and returns the plain ticket + bridge URL.
 * 2. The desktop main process stages key material, the managed ssh config,
 *    and the ticket file for the ProxyCommand bridge.
 * 3. `machine.sshKeys.add` (over the workspace gateway) authorizes the
 *    desktop's public key inside the sandbox — reusing the machine-host RPC.
 */

export const cloudSshSupported = (): boolean =>
	getAppBridge()?.cloudSshPrepare !== undefined;

const requestSshAccess = (workspaceId: string) =>
	runControlPlane((client) =>
		client["cloud.workspaces.sshAccess"]({ workspaceId }),
	);

const SSH_GATEWAY_READY_TIMEOUT_MS = 30_000;

const waitForWorkspaceGateway = (
	environmentId: EnvironmentId,
	key: ReturnType<typeof retainEnvironmentShell>["key"],
): Promise<void> => {
	const bus = getRendererClientBus();
	if (bus.client(environmentId) !== null) return Promise.resolve();
	return new Promise((resolve, reject) => {
		let settled = false;
		let unsubscribe: () => void = () => undefined;
		const finish = (cause?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			unsubscribe();
			if (cause === undefined) resolve();
			else reject(cause);
		};
		const check = (): void => {
			if (bus.client(environmentId) !== null) {
				finish();
				return;
			}
			const connection = bus.connection(environmentId);
			if (
				connection.phase === "blocked-auth" ||
				connection.phase === "update-required" ||
				connection.phase === "revoked"
			) {
				finish(
					new Error(
						connection.error ??
							"The cloud workspace gateway is not available for SSH.",
					),
				);
			}
		};
		const timeout = setTimeout(() => {
			const connection = bus.connection(environmentId);
			finish(
				new Error(
					connection.error ??
						"Timed out waiting for the cloud workspace gateway.",
				),
			);
		}, SSH_GATEWAY_READY_TIMEOUT_MS);
		unsubscribe = bus.subscribe(key, check);
		check();
	});
};

export const prepareCloudWorkspaceSsh = async (
	workspaceId: string,
): Promise<CloudSshPrepared> => {
	const app = getAppBridge();
	if (app?.cloudSshPrepare === undefined || app.openSshTarget === undefined)
		throw new Error("SSH access requires the Zuse desktop app.");
	const environmentId = EnvironmentId.make(workspaceId);
	const retained = retainEnvironmentShell({ environmentId }, "wake");
	try {
		// A relay workspace can report ready before its renderer gateway lease has
		// finished reconnecting. SSH and rsync both require that live client for
		// key authorization, so keep a transient wake lease through the command.
		await waitForWorkspaceGateway(environmentId, retained.key);
		let access: Awaited<ReturnType<typeof requestSshAccess>>;
		try {
			access = await requestSshAccess(workspaceId);
		} catch (cause) {
			// The relay rejects unknown routes while SSH support is still rolling
			// out; surface that as a capability gap instead of a raw RPC error.
			const detail = cause instanceof Error ? cause.message : String(cause);
			throw new Error(
				`SSH access is not available for this workspace yet — the cloud service and workspace image need the SSH update.${
					detail.length > 0 && detail !== "{}" ? ` (${detail})` : ""
				}`,
			);
		}
		const prepared = await app.cloudSshPrepare({
			workspaceId: access.workspaceId,
			wsUrl: access.wsUrl,
			ticket: access.ticket,
			expiresAt: access.expiresAt,
			user: access.user,
			workspacePath: access.workspacePath,
		});
		if (prepared === null)
			throw new Error("Could not prepare SSH access on this device.");
		// Idempotent: the sandbox host service dedupes keys by fingerprint.
		await dispatchEnvironmentShellCommand<
			{ publicKey: string; label?: string },
			MachineSshKey
		>({
			environmentId,
			kind: "machine.sshKeys.add",
			commandId: CommandId.make(`cloud-ssh-key:${crypto.randomUUID()}`),
			payload: { publicKey: prepared.publicKey, label: "zuse-desktop" },
		});
		return prepared;
	} finally {
		retained.lease.release();
	}
};

export type CloudSshTarget = "cursor" | "zed" | "terminal";

/** Prepare access, then launch the chosen editor/terminal over SSH. */
export const openCloudWorkspaceSsh = async (
	workspaceId: string,
	target: CloudSshTarget,
): Promise<void> => {
	const prepared = await prepareCloudWorkspaceSsh(workspaceId);
	const app = getAppBridge();
	const opened = await app?.openSshTarget?.(
		target,
		prepared.hostAlias,
		prepared.remotePath,
	);
	if (opened !== true)
		throw new Error(
			target === "zed"
				? "Could not launch Zed. Install its `zed` CLI command and retry."
				: "Could not launch the selected app.",
		);
};
