import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	makeRpcClientSession,
	withWireProtocolVersion,
} from "@zuse/client-runtime/connection";
import { wsClientProtocolLayer } from "@zuse/client-runtime/ws-protocol";
import {
	COMPATIBLE_SERVE_RUNTIME_VERSION,
	type EnsureSshEnvironmentInput,
	EnvironmentDescriptor,
	MemoizeRpcs,
	RemoteEnvironmentProfile,
	type SshEnvironmentConnection,
	type SshEnvironmentTarget,
	WIRE_PROTOCOL_VERSION,
} from "@zuse/contracts";
import {
	discoverSshHosts,
	openTunnel,
	parseLaunchResult,
	remoteBootstrapScript,
	resolveSshTarget,
	type TunnelHandle,
} from "@zuse/ssh";
import { Effect } from "effect";

import { RemoteEnvironmentProfileStore } from "./profile-store.ts";

export type SshEnvironmentHandle = {
	connection: SshEnvironmentConnection;
	tunnel: TunnelHandle;
	close: () => Promise<void>;
};

const targetKey = (target: SshEnvironmentTarget): string =>
	JSON.stringify([target.alias, target.hostname, target.username, target.port]);

const profileIdFor = (target: SshEnvironmentTarget): string =>
	`ssh_${createHash("sha256").update(targetKey(target)).digest("hex").slice(0, 24)}`;

export const assertEnvironmentIdentity = (
	expectedEnvironmentId: string | null,
	actualEnvironmentId: string,
): void => {
	if (
		expectedEnvironmentId !== null &&
		expectedEnvironmentId !== actualEnvironmentId
	) {
		throw new Error(
			"The remote computer identity changed. Remove and add it again to confirm the new environment.",
		);
	}
};

const sshDestination = (target: SshEnvironmentTarget): string =>
	target.username ? `${target.username}@${target.alias}` : target.alias;

const appendDiagnostic = (current: string, chunk: unknown): string =>
	Array.from(`${current}${Buffer.from(chunk as Uint8Array).toString("utf8")}`)
		.map((character) => {
			const code = character.charCodeAt(0);
			return (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
				code === 127
				? "?"
				: character;
		})
		.join("")
		.slice(-65_536);

const launchRemoteServer = async (
	target: SshEnvironmentTarget,
	signal: AbortSignal,
) => {
	const args = [
		"-o",
		"BatchMode=yes",
		"-o",
		"ConnectTimeout=15",
		...(target.port === null ? [] : ["-p", String(target.port)]),
		sshDestination(target),
		"sh",
		"-s",
	];
	const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
	const abort = (): void => {
		child.kill("SIGTERM");
	};
	signal.addEventListener("abort", abort, { once: true });
	child.stdin.end(remoteBootstrapScript(COMPATIBLE_SERVE_RUNTIME_VERSION));
	let output = "";
	let diagnostic = "";
	child.stdout.on("data", (chunk) => {
		output = appendDiagnostic(output, chunk);
	});
	child.stderr.on("data", (chunk) => {
		diagnostic = appendDiagnostic(diagnostic, chunk);
	});
	const code = await new Promise<number | null>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error("Remote Zuse bootstrap timed out after 2 minutes."));
		}, 120_000);
		child.once("error", (cause) => {
			clearTimeout(timer);
			reject(cause);
		});
		child.once("exit", (result) => {
			clearTimeout(timer);
			if (signal.aborted) reject(new Error("SSH connection was cancelled."));
			else resolve(result);
		});
	}).finally(() => signal.removeEventListener("abort", abort));
	const lines = output.trim().split(/\r?\n/u);
	if (code !== 0) {
		throw new Error(diagnostic.trim() || `SSH bootstrap exited with ${code}`);
	}
	return parseLaunchResult(lines.at(-1) ?? "");
};

export const waitForBounded = <A>(
	promise: Promise<A>,
	signal: AbortSignal,
	timeoutMessage: string,
	timeoutMs = 15_000,
): Promise<A> =>
	new Promise((resolve, reject) => {
		let settled = false;
		const finish = (result: { value: A } | { cause: unknown }): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			if ("value" in result) resolve(result.value);
			else reject(result.cause);
		};
		const abort = (): void =>
			finish({ cause: new Error("SSH connection was cancelled.") });
		const timer = setTimeout(
			() => finish({ cause: new Error(timeoutMessage) }),
			timeoutMs,
		);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		void promise.then(
			(value) => finish({ value }),
			(cause) => finish({ cause }),
		);
	});

const describeTunnel = async (
	tunnel: TunnelHandle,
	signal: AbortSignal,
): Promise<EnvironmentDescriptor> => {
	const sessionPromise = makeRpcClientSession(
		wsClientProtocolLayer(
			withWireProtocolVersion(tunnel.wsBaseUrl, WIRE_PROTOCOL_VERSION),
		),
		MemoizeRpcs,
		{
			protocolVersion: WIRE_PROTOCOL_VERSION,
			perform: (client, hello) => client["connect.handshake"](hello),
		},
	);
	const session = await waitForBounded(
		sessionPromise,
		signal,
		"Remote Zuse handshake timed out after 15 seconds.",
	).catch((cause) => {
		void sessionPromise.then(
			(lateSession) => lateSession.dispose(),
			() => undefined,
		);
		throw cause;
	});
	try {
		const descriptor = await waitForBounded(
			Effect.runPromise(session.client["connect.describe"]()),
			signal,
			"Remote Zuse describe timed out after 15 seconds.",
		);
		return EnvironmentDescriptor.make({
			...descriptor,
			providerKind: "ssh",
			endpoint: {
				httpBaseUrl: `http://127.0.0.1:${tunnel.localPort}`,
				wsBaseUrl: tunnel.wsBaseUrl,
			},
		});
	} finally {
		await session.dispose();
	}
};

export class SshEnvironmentManager {
	private readonly profiles: RemoteEnvironmentProfileStore;
	private readonly handles = new Map<string, SshEnvironmentHandle>();
	private readonly pending = new Map<
		string,
		{
			readonly promise: Promise<SshEnvironmentConnection>;
			readonly controller: AbortController;
		}
	>();

	constructor(userData: string) {
		this.profiles = new RemoteEnvironmentProfileStore(userData);
	}

	initialize(): Promise<ReadonlyArray<RemoteEnvironmentProfile>> {
		return this.profiles.load();
	}

	listProfiles(): ReadonlyArray<RemoteEnvironmentProfile> {
		return this.profiles.list();
	}

	discoverHosts() {
		return Effect.runPromise(discoverSshHosts());
	}

	ensure(input: EnsureSshEnvironmentInput): Promise<SshEnvironmentConnection> {
		const saved =
			"profileId" in input ? this.profiles.get(input.profileId) : null;
		if ("profileId" in input && saved === null) {
			return Promise.reject(new Error("Saved SSH computer was not found."));
		}
		const target = saved?.target ?? ("target" in input ? input.target : null);
		if (target === null)
			return Promise.reject(new Error("SSH target is required."));
		const profileId = saved?.profileId ?? profileIdFor(target);
		const existing = this.handles.get(profileId);
		if (
			existing !== undefined &&
			existing.tunnel.process.exitCode === null &&
			existing.tunnel.process.signalCode === null
		) {
			return Promise.resolve(existing.connection);
		}
		const inFlight = this.pending.get(profileId);
		if (inFlight !== undefined) return inFlight.promise;
		const controller = new AbortController();
		const operation = this.connect({
			profileId,
			target,
			label:
				saved?.label ??
				("label" in input ? input.label?.trim() : undefined) ??
				target.alias,
			expectedEnvironmentId: saved?.environmentId ?? null,
			signal: controller.signal,
		}).finally(() => {
			if (this.pending.get(profileId)?.promise === operation) {
				this.pending.delete(profileId);
			}
		});
		this.pending.set(profileId, { promise: operation, controller });
		return operation;
	}

	async disconnect(profileId: string): Promise<void> {
		const pending = this.pending.get(profileId);
		pending?.controller.abort();
		await pending?.promise.catch(() => undefined);
		const handle = this.handles.get(profileId);
		this.handles.delete(profileId);
		await handle?.close();
	}

	async remove(profileId: string): Promise<void> {
		await this.disconnect(profileId);
		await this.profiles.remove(profileId);
	}

	async updateLabel(
		profileId: string,
		label: string,
	): Promise<RemoteEnvironmentProfile> {
		const current = this.profiles.get(profileId);
		const normalized = label.trim();
		if (current === null) throw new Error("Saved SSH computer was not found.");
		if (normalized.length === 0) throw new Error("Computer label is required.");
		const profile = RemoteEnvironmentProfile.make({
			...current,
			label: normalized,
		});
		await this.profiles.put(profile);
		const handle = this.handles.get(profileId);
		if (handle !== undefined) {
			handle.connection = { ...handle.connection, profile };
		}
		return profile;
	}

	async close(): Promise<void> {
		const pending = [...this.pending.values()];
		for (const attempt of pending) attempt.controller.abort();
		await Promise.allSettled(pending.map((attempt) => attempt.promise));
		const handles = [...this.handles.values()];
		this.handles.clear();
		await Promise.all(handles.map((handle) => handle.close()));
	}

	private async connect(input: {
		readonly profileId: string;
		readonly target: SshEnvironmentTarget;
		readonly label: string;
		readonly expectedEnvironmentId: string | null;
		readonly signal: AbortSignal;
	}): Promise<SshEnvironmentConnection> {
		const resolvedTarget = await Effect.runPromise(
			resolveSshTarget(input.target),
		);
		if (input.signal.aborted) throw new Error("SSH connection was cancelled.");
		const launch = await launchRemoteServer(resolvedTarget, input.signal);
		if (input.signal.aborted) throw new Error("SSH connection was cancelled.");
		const tunnel = await Effect.runPromise(
			openTunnel({ target: resolvedTarget, remotePort: launch.remotePort }),
		);
		try {
			if (input.signal.aborted)
				throw new Error("SSH connection was cancelled.");
			const descriptor = await describeTunnel(tunnel, input.signal).catch(
				(cause) => {
					throw new Error(
						`Remote Zuse readiness validation failed. Another service may be using remote loopback port ${launch.remotePort}. ${cause instanceof Error ? cause.message : String(cause)}`,
					);
				},
			);
			if (input.signal.aborted)
				throw new Error("SSH connection was cancelled.");
			assertEnvironmentIdentity(
				input.expectedEnvironmentId,
				descriptor.environmentId,
			);
			const profile = RemoteEnvironmentProfile.make({
				profileId: input.profileId,
				environmentId: descriptor.environmentId,
				label: input.label || descriptor.label || resolvedTarget.alias,
				target: resolvedTarget,
				lastConnectedAt: new Date().toISOString(),
			});
			const connection = { descriptor, profile };
			const handle: SshEnvironmentHandle = {
				connection,
				tunnel,
				close: tunnel.close,
			};
			this.handles.set(profile.profileId, handle);
			tunnel.process.once("exit", () => {
				if (this.handles.get(profile.profileId) === handle) {
					this.handles.delete(profile.profileId);
				}
			});
			if (input.signal.aborted)
				throw new Error("SSH connection was cancelled.");
			await this.profiles.put(profile);
			return connection;
		} catch (cause) {
			await tunnel.close();
			throw cause;
		}
	}
}
