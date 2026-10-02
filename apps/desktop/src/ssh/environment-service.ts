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
	SelfHostedSetupEvent,
	SelfHostedSetupOperation,
	type SelfHostedSetupRequest,
	type SshEnvironmentConnection,
	type SshEnvironmentTarget,
	WIRE_PROTOCOL_VERSION,
} from "@zuse/contracts";
import {
	discoverSshHosts,
	openTunnel,
	parseLaunchResult,
	parseSelfHostedCliEvent,
	parseSelfHostedPreflight,
	remoteBootstrapScript,
	resolveSshTarget,
	selfHostedBootstrapScript,
	selfHostedPreflightScript,
	selfHostedRemoteLaunchScript,
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

const sshScriptArgs = (target: SshEnvironmentTarget): ReadonlyArray<string> => [
	"-o",
	"BatchMode=yes",
	"-o",
	"ConnectTimeout=15",
	...(target.port === null ? [] : ["-p", String(target.port)]),
	sshDestination(target),
	"sh",
	"-s",
];

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

/** Stable UI-safe codes: never surface SSH arguments or remote command output. */
export const selfHostedSetupErrorCode = (cause: unknown): string => {
	const message = (
		cause instanceof Error ? cause.message : String(cause)
	).toLowerCase();
	if (message.includes("cancel")) return "cancelled";
	if (message.includes("timed_out") || message.includes("timed out"))
		return "ssh_timeout";
	if (message.includes("host key") || message.includes("fingerprint"))
		return "host_key_verification_failed";
	if (
		message.includes("permission denied") ||
		message.includes("authentication")
	)
		return "ssh_authentication_failed";
	if (message.includes("unsupported_linux_distribution"))
		return "unsupported_linux_distribution";
	if (message.includes("unsupported_architecture"))
		return "unsupported_architecture";
	if (message.includes("systemd_user_unavailable"))
		return "systemd_user_unavailable";
	if (message.includes("linger_required")) return "linger_required";
	if (message.includes("missing_prerequisites_and_sudo"))
		return "prerequisites_require_sudo";
	if (message.includes("api_not_ready")) return "api_not_ready";
	return "setup_failed";
};

const runRemoteScript = async (
	target: SshEnvironmentTarget,
	script: string,
	signal: AbortSignal,
	timeoutMs: number,
	onLine?: (line: string) => void,
): Promise<{ readonly output: string; readonly diagnostic: string }> => {
	const child = spawn("ssh", sshScriptArgs(target), {
		stdio: ["pipe", "pipe", "pipe"],
	});
	const abort = (): void => {
		child.kill("SIGTERM");
	};
	signal.addEventListener("abort", abort, { once: true });
	child.stdin.end(script);
	let output = "";
	let diagnostic = "";
	let pendingLine = "";
	child.stdout.on("data", (chunk) => {
		output = appendDiagnostic(output, chunk);
		pendingLine += Buffer.from(chunk as Uint8Array).toString("utf8");
		const lines = pendingLine.split(/\r?\n/u);
		pendingLine = lines.pop() ?? "";
		for (const line of lines) onLine?.(line);
	});
	child.stderr.on("data", (chunk) => {
		diagnostic = appendDiagnostic(diagnostic, chunk);
	});
	const code = await new Promise<number | null>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error("ssh_operation_timed_out"));
		}, timeoutMs);
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
	if (pendingLine.length > 0) onLine?.(pendingLine);
	if (code !== 0) {
		throw new Error(diagnostic.trim() || `SSH bootstrap exited with ${code}`);
	}
	return { output, diagnostic };
};

const launchRemoteServer = async (
	target: SshEnvironmentTarget,
	script: string,
	signal: AbortSignal,
) => {
	const { output } = await runRemoteScript(target, script, signal, 120_000);
	const lines = output.trim().split(/\r?\n/u);
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
	private readonly setupControllers = new Map<string, AbortController>();
	private readonly setupListeners = new Set<
		(event: SelfHostedSetupEvent) => void
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

	onSetupEvent(listener: (event: SelfHostedSetupEvent) => void): () => void {
		this.setupListeners.add(listener);
		return () => this.setupListeners.delete(listener);
	}

	private emitSetup(event: SelfHostedSetupEvent): void {
		for (const listener of this.setupListeners) listener(event);
	}

	startSelfHostedSetup(
		input: SelfHostedSetupRequest,
	): SelfHostedSetupOperation {
		if (this.setupControllers.has(input.operationId)) {
			throw new Error("A setup operation with this id is already running.");
		}
		const controller = new AbortController();
		this.setupControllers.set(input.operationId, controller);
		const startedAt = Date.now();
		const event = (
			phase: SelfHostedSetupEvent["phase"],
			message: string,
			extra: Partial<SelfHostedSetupEvent> = {},
		) =>
			SelfHostedSetupEvent.make({
				version: 1,
				operationId: input.operationId,
				phase,
				message,
				occurredAt: Date.now(),
				...extra,
			});
		void this.runSelfHostedSetup(input, controller.signal, event)
			.catch((cause) => {
				this.emitSetup(
					event(
						controller.signal.aborted ? "cancelled" : "failed",
						controller.signal.aborted
							? "Setup was cancelled."
							: "The server could not be set up.",
						{
							errorCode: controller.signal.aborted
								? "cancelled"
								: selfHostedSetupErrorCode(cause),
						},
					),
				);
			})
			.finally(() => this.setupControllers.delete(input.operationId));
		return SelfHostedSetupOperation.make({
			operationId: input.operationId,
			phase: "connecting",
			startedAt,
		});
	}

	cancelSelfHostedSetup(operationId: string): void {
		this.setupControllers.get(operationId)?.abort();
	}

	private async runSelfHostedSetup(
		input: SelfHostedSetupRequest,
		signal: AbortSignal,
		event: (
			phase: SelfHostedSetupEvent["phase"],
			message: string,
			extra?: Partial<SelfHostedSetupEvent>,
		) => SelfHostedSetupEvent,
	): Promise<void> {
		this.emitSetup(event("connecting", "Connecting over SSH"));
		const target = await Effect.runPromise(resolveSshTarget(input.target));
		this.emitSetup(event("preflight", "Checking server compatibility"));
		const preflightResult = await runRemoteScript(
			target,
			selfHostedPreflightScript,
			signal,
			30_000,
		);
		const preflight = parseSelfHostedPreflight(preflightResult.output);
		this.emitSetup(
			event("preflight", "Server compatibility checked", { preflight }),
		);
		if (!preflight.supported) {
			throw new Error(preflight.blockingReason ?? "unsupported_server");
		}
		this.emitSetup(event("installing", "Installing Zuse Serve"));
		let readyEnvironmentId: SelfHostedSetupEvent["environmentId"];
		await runRemoteScript(
			target,
			selfHostedBootstrapScript(COMPATIBLE_SERVE_RUNTIME_VERSION),
			signal,
			10 * 60_000,
			(line) => {
				const cliEvent = parseSelfHostedCliEvent(line);
				if (cliEvent === null) return;
				if (cliEvent.type === "authorization_required") {
					this.emitSetup(
						event("authorizing", "Authorize this server", {
							userCode: cliEvent.userCode,
							verificationUri: cliEvent.verificationUri,
						}),
					);
				} else if (cliEvent.type === "phase") {
					this.emitSetup(event(cliEvent.phase, cliEvent.message));
				} else {
					readyEnvironmentId = cliEvent.environmentId;
				}
			},
		);
		if (readyEnvironmentId === undefined) throw new Error("api_not_ready");
		const profileId = profileIdFor(target);
		const profile = RemoteEnvironmentProfile.make({
			profileId,
			environmentId: readyEnvironmentId,
			label: input.label.trim() || target.alias,
			target,
			connectionMode: "account-linked",
			lastConnectedAt: new Date().toISOString(),
		});
		await this.profiles.put(profile);
		this.emitSetup(
			event("ready", "Server is available on your account", {
				environmentId: readyEnvironmentId,
				profileId,
			}),
		);
	}

	/** The resolved ssh target of a currently connected environment, if any. */
	resolvedTargetFor(environmentId: string): SshEnvironmentTarget | null {
		for (const handle of this.handles.values()) {
			if (handle.connection.descriptor.environmentId === environmentId) {
				return handle.connection.profile.target;
			}
		}
		return null;
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
			connectionMode: saved?.connectionMode ?? "local-only",
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
		for (const controller of this.setupControllers.values()) controller.abort();
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
		readonly connectionMode: "local-only" | "account-linked";
		readonly label: string;
		readonly expectedEnvironmentId: string | null;
		readonly signal: AbortSignal;
	}): Promise<SshEnvironmentConnection> {
		const resolvedTarget = await Effect.runPromise(
			resolveSshTarget(input.target),
		);
		if (input.signal.aborted) throw new Error("SSH connection was cancelled.");
		const launch = await launchRemoteServer(
			resolvedTarget,
			input.connectionMode === "account-linked"
				? selfHostedRemoteLaunchScript
				: remoteBootstrapScript(COMPATIBLE_SERVE_RUNTIME_VERSION),
			input.signal,
		);
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
				connectionMode: input.connectionMode,
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
