import type { CloudCommandTransport } from "@zuse/client-runtime/client-persistence";
import {
	type ClientCommand,
	CloudCommandTerminalError,
	CloudCommandTransportUnavailableError,
	type CommandFingerprint,
} from "@zuse/client-runtime/client-persistence";
import {
	CloudCommandEnvelope,
	type CommandStatus,
	SessionId,
} from "@zuse/contracts";
import {
	cloudCommandAdditionalData,
	decryptCloudCommandBody,
	encryptCloudCommandBody,
	keyedCloudCommandFingerprint,
} from "@zuse/utils/cloud-command-crypto";
import { Effect } from "effect";

import { getControlPlaneRpcClient } from "./rpc-client.ts";

const terminal = (status: CommandStatus): boolean =>
	status.state === "applied" ||
	status.state === "rejected" ||
	status.state === "expired" ||
	status.state === "cancelled" ||
	status.state === "outcome-unknown";

const sessionIdOf = (command: ClientCommand): string => {
	const payload = command.payload as Readonly<Record<string, unknown>>;
	if (typeof payload.sessionId === "string") return payload.sessionId;
	if (command.resource !== null && "sessionId" in command.resource.ref)
		return command.resource.ref.sessionId;
	throw new Error("Durable cloud commands require an explicit session");
};

const terminalError = (status: CommandStatus): CloudCommandTerminalError => {
	const label =
		status.state === "outcome-unknown"
			? "The runtime storage was replaced, so the command outcome is unknown."
			: status.state === "expired"
				? "This interaction expired while the agent was restarting."
				: status.state === "cancelled"
					? "The queued command was cancelled."
					: `The agent rejected this command${status.category === undefined ? "." : `: ${status.category}`}`;
	return new CloudCommandTerminalError(status.state, status.category, label);
};

const errorCode = (cause: unknown): unknown =>
	typeof cause === "object" && cause !== null
		? Reflect.get(cause, "code")
		: undefined;

const destructiveWorkspaceLifecycle = (workspace: {
	readonly state: string;
	readonly desiredState: string;
}): boolean =>
	workspace.state === "archiving" ||
	workspace.state === "archived" ||
	workspace.state === "deleting" ||
	workspace.state === "deleted" ||
	workspace.desiredState === "archived" ||
	workspace.desiredState === "deleted";

const workspaceUnavailable = (): CloudCommandTerminalError =>
	new CloudCommandTerminalError(
		"cancelled",
		"workspace-deleted",
		"This workspace was archived or deleted before the command was accepted.",
	);

const dataKey = async (workspaceId: string) => {
	const control = await getControlPlaneRpcClient();
	try {
		return await Effect.runPromise(
			control["cloud.commands.dataKey"]({ workspaceId }),
		);
	} catch (cause) {
		if (errorCode(cause) !== "not-found") throw cause;

		// During the additive v3 rollout, an older control plane returns the same
		// endpoint-level 404 as a genuinely missing workspace. Disambiguate through
		// the long-lived v2 workspace route before assigning a terminal lifecycle.
		try {
			const workspace = await Effect.runPromise(
				control["cloud.workspaces.get"]({ workspaceId }),
			);
			if (destructiveWorkspaceLifecycle(workspace))
				throw workspaceUnavailable();
			throw new CloudCommandTransportUnavailableError(
				"Durable cloud commands are not available on this control plane",
			);
		} catch (workspaceCause) {
			if (
				workspaceCause instanceof CloudCommandTerminalError ||
				workspaceCause instanceof CloudCommandTransportUnavailableError
			)
				throw workspaceCause;
			if (errorCode(workspaceCause) === "not-found")
				throw workspaceUnavailable();
			throw workspaceCause;
		}
	}
};

/** Opaque control-plane transport; it never requests a compute connection. */
export const cloudCommandTransport: CloudCommandTransport = {
	dispatch: <Result>({
		command,
		fingerprint,
	}: {
		command: ClientCommand<unknown, Result>;
		fingerprint: CommandFingerprint;
	}) => {
		const statusListeners = new Set<(status: CommandStatus) => void>();
		let latestStatus: CommandStatus | null = null;
		const publishStatus = (status: CommandStatus) => {
			latestStatus = status;
			for (const listener of statusListeners) listener(status);
		};
		let envelopePromise: Promise<{
			envelope: CloudCommandEnvelope;
			encodedKey: string;
		}> | null = null;
		const envelope = () => {
			envelopePromise ??= (async () => {
				const payload = command.payload as Readonly<Record<string, unknown>>;
				const composer = payload.input as
					| Readonly<{ attachments?: readonly unknown[] }>
					| undefined;
				if ((composer?.attachments?.length ?? 0) > 0)
					throw new CloudCommandTransportUnavailableError(
						"Encrypted attachment staging is not enabled for this rollout",
					);
				const workspaceId = String(command.environmentId);
				const key = await dataKey(workspaceId);
				if (!key.mailboxEnabled)
					throw new CloudCommandTransportUnavailableError(
						"Durable cloud commands are not enabled for this deployment",
					);
				const plaintext = new TextEncoder().encode(JSON.stringify(payload));
				const keyedFingerprint = await keyedCloudCommandFingerprint({
					encodedKey: key.encodedKey,
					canonicalPlaintext: plaintext,
				});
				const metadata = {
					protocolVersion: 3 as const,
					workspaceId,
					sessionId: SessionId.make(sessionIdOf(command)),
					commandId: command.commandId,
					kind: command.kind,
					fingerprint: keyedFingerprint,
					schemaVersion: 1,
					keyVersion: key.keyVersion,
					destructionFence: key.destructionFence,
					createdAt: command.createdAt,
					dependencies: [],
				};
				const encrypted = await encryptCloudCommandBody({
					encodedKey: key.encodedKey,
					additionalData: cloudCommandAdditionalData(metadata),
					plaintext,
				});
				return {
					envelope: CloudCommandEnvelope.make({ ...metadata, ...encrypted }),
					encodedKey: key.encodedKey,
				};
			})();
			return envelopePromise;
		};
		const accepted = envelope().then(async ({ envelope: durableEnvelope }) => {
			const control = await getControlPlaneRpcClient();
			return Effect.runPromise(
				control["cloud.commands.enqueue"](durableEnvelope),
			);
		});
		const result = accepted.then(async (acceptance) => {
			const prepared = await envelope();
			let revision = acceptance.revision;
			const resolveTerminal = async (status: CommandStatus) => {
				if (status.state !== "applied") throw terminalError(status);
				if (
					status.resultIv === undefined ||
					status.resultCiphertext === undefined
				)
					throw new CloudCommandTerminalError(
						status.state,
						"result-expired",
						"The command was applied, but its result has expired.",
					);
				const plaintext = await decryptCloudCommandBody({
					encodedKey: prepared.encodedKey,
					additionalData: cloudCommandAdditionalData(prepared.envelope),
					iv: status.resultIv,
					ciphertext: status.resultCiphertext,
				});
				const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as {
					result: Result;
				};
				return {
					commandId: command.commandId,
					fingerprint,
					receivedAt: status.updatedAt,
					result: decoded.result,
				};
			};
			// Enqueue retries can find an already-terminal command. Read once before
			// long-polling so its terminal revision can never be skipped.
			const control = await getControlPlaneRpcClient();
			const current = await Effect.runPromise(
				control["cloud.commands.status"]({
					workspaceId: prepared.envelope.workspaceId,
					commandId: command.commandId,
				}),
			);
			publishStatus(current);
			if (terminal(current)) return resolveTerminal(current);
			revision = Math.max(revision, current.revision);
			for (;;) {
				const control = await getControlPlaneRpcClient();
				const page = await Effect.runPromise(
					control["cloud.commands.watch"]({
						workspaceId: prepared.envelope.workspaceId,
						afterRevision: revision,
					}),
				);
				revision = page.nextRevision;
				const status = page.changes.find(
					(change) => change.commandId === command.commandId,
				);
				if (status === undefined) continue;
				publishStatus(status);
				if (!terminal(status)) continue;
				return resolveTerminal(status);
			}
		});
		return {
			accepted,
			result,
			encryptedEnvelope: envelope().then((prepared) => prepared.envelope),
			cancel: async () => {
				const prepared = await envelope();
				const control = await getControlPlaneRpcClient();
				return Effect.runPromise(
					control["cloud.commands.cancel"]({
						workspaceId: prepared.envelope.workspaceId,
						commandId: command.commandId,
					}),
				);
			},
			subscribeStatus: (listener) => {
				statusListeners.add(listener);
				if (latestStatus !== null) listener(latestStatus);
				return () => statusListeners.delete(listener);
			},
		};
	},
};
