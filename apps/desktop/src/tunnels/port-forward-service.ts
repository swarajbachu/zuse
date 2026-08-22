import { createServer } from "node:net";
import type { SshEnvironmentTarget } from "@zuse/contracts";
import { openTunnel, randomLocalPort, type TunnelHandle } from "@zuse/ssh";
import { Effect } from "effect";

import {
	cloudSshConfigPath,
	cloudSshHostAlias,
} from "../ssh/cloud-ssh-service.ts";

/**
 * Local forwards for dev servers on remote environments. SSH boxes forward
 * over a plain `ssh -N -L`; cloud workspaces ride the managed `zuse-*` alias
 * whose ProxyCommand bridges a WebSocket to the sandbox's sshd. Managed
 * persistent machines add a target kind here once they expose an ssh path.
 */
export type PortForwardTarget =
	| { readonly kind: "ssh"; readonly target: SshEnvironmentTarget }
	| { readonly kind: "cloud"; readonly workspaceId: string };

export interface PortForwardSummary {
	readonly environmentId: string;
	readonly remotePort: number;
	readonly localPort: number;
}

export type OpenForwardTunnel = (input: {
	readonly target: PortForwardTarget;
	readonly remotePort: number;
	readonly localPort: number;
}) => Promise<TunnelHandle>;

const defaultOpenForwardTunnel: OpenForwardTunnel = (input) =>
	Effect.runPromise(
		input.target.kind === "cloud"
			? openTunnel({
					host: cloudSshHostAlias(input.target.workspaceId),
					remotePort: input.remotePort,
					localPort: input.localPort,
					configFile: cloudSshConfigPath(),
				})
			: openTunnel({
					target: input.target.target,
					remotePort: input.remotePort,
					localPort: input.localPort,
				}),
	);

const localPortFree = (port: number): Promise<boolean> =>
	new Promise((resolve) => {
		const probe = createServer();
		probe.once("error", () => resolve(false));
		probe.listen(port, "127.0.0.1", () => {
			probe.close(() => resolve(true));
		});
	});

const tunnelAlive = (handle: TunnelHandle): boolean =>
	handle.process.exitCode === null && handle.process.signalCode === null;

const forwardKey = (environmentId: string, remotePort: number): string =>
	`${environmentId}:${remotePort}`;
const MAX_LOCAL_PORT_CANDIDATES = 5;

export const retryableLocalBindFailure = (cause: unknown): boolean => {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return /(?:bind(?:ing)? failed|address already in use|cannot listen|could not request local forwarding)/iu.test(
		detail,
	);
};

type ForwardEntry = {
	readonly summary: PortForwardSummary;
	readonly handle: TunnelHandle;
};

type PendingForward = {
	readonly environmentId: string;
	cancelled: boolean;
	operation: Promise<PortForwardSummary>;
};

export class PortForwardManager {
	private readonly forwards = new Map<string, ForwardEntry>();
	private readonly pending = new Map<string, PendingForward>();

	constructor(
		private readonly openForwardTunnel: OpenForwardTunnel = defaultOpenForwardTunnel,
		private readonly isLocalPortFree: (
			port: number,
		) => Promise<boolean> = localPortFree,
		private readonly allocateLocalPort: () => number = randomLocalPort,
	) {}

	/** Idempotent: an existing live forward for the same port is returned. */
	open(input: {
		readonly environmentId: string;
		readonly target: PortForwardTarget;
		readonly remotePort: number;
	}): Promise<PortForwardSummary> {
		const key = forwardKey(input.environmentId, input.remotePort);
		const existing = this.forwards.get(key);
		if (existing !== undefined && tunnelAlive(existing.handle)) {
			return Promise.resolve(existing.summary);
		}
		const inFlight = this.pending.get(key);
		if (inFlight !== undefined) return inFlight.operation;
		const pending: PendingForward = {
			environmentId: input.environmentId,
			cancelled: false,
			operation: Promise.resolve({
				environmentId: input.environmentId,
				remotePort: input.remotePort,
				localPort: 0,
			}),
		};
		const operation = this.connect(key, input).then(async (summary) => {
			if (!pending.cancelled) return summary;
			const opened = this.forwards.get(key);
			this.forwards.delete(key);
			await opened?.handle.close();
			throw new Error("Port forward closed before it became ready.");
		});
		pending.operation = operation.finally(() => {
			if (this.pending.get(key) === pending) this.pending.delete(key);
		});
		this.pending.set(key, pending);
		return pending.operation;
	}

	async close(environmentId: string, remotePort: number): Promise<void> {
		const key = forwardKey(environmentId, remotePort);
		const pending = this.pending.get(key);
		if (pending !== undefined) pending.cancelled = true;
		const entry = this.forwards.get(key);
		this.forwards.delete(key);
		await Promise.allSettled([
			entry?.handle.close() ?? Promise.resolve(),
			pending?.operation ?? Promise.resolve(),
		]);
	}

	async closeForEnvironment(environmentId: string): Promise<void> {
		const pending = [...this.pending.values()].filter(
			(entry) => entry.environmentId === environmentId,
		);
		for (const entry of pending) entry.cancelled = true;
		const entries = [...this.forwards.entries()].filter(
			([, entry]) => entry.summary.environmentId === environmentId,
		);
		for (const [key] of entries) this.forwards.delete(key);
		await Promise.allSettled([
			...entries.map(([, entry]) => entry.handle.close()),
			...pending.map((entry) => entry.operation),
		]);
	}

	async closeAll(): Promise<void> {
		const pending = [...this.pending.values()];
		for (const entry of pending) entry.cancelled = true;
		const entries = [...this.forwards.values()];
		this.forwards.clear();
		await Promise.allSettled([
			...entries.map((entry) => entry.handle.close()),
			...pending.map((entry) => entry.operation),
		]);
	}

	list(environmentId?: string): ReadonlyArray<PortForwardSummary> {
		return [...this.forwards.values()]
			.filter(
				(entry) =>
					tunnelAlive(entry.handle) &&
					(environmentId === undefined ||
						entry.summary.environmentId === environmentId),
			)
			.map((entry) => entry.summary);
	}

	private async connect(
		key: string,
		input: {
			readonly environmentId: string;
			readonly target: PortForwardTarget;
			readonly remotePort: number;
		},
	): Promise<PortForwardSummary> {
		// Prefer the matching port, then try a bounded set of verified random
		// candidates. ExitOnForwardFailure still catches the bind race between
		// the probe and ssh taking ownership of the port.
		const candidates = [input.remotePort];
		for (
			let draws = 0;
			candidates.length < MAX_LOCAL_PORT_CANDIDATES && draws < 20;
			draws += 1
		) {
			const candidate = this.allocateLocalPort();
			if (!candidates.includes(candidate)) candidates.push(candidate);
		}
		let handle: TunnelHandle | null = null;
		let lastFailure: unknown = new Error("No local port was available.");
		for (const localPort of candidates) {
			if (!(await this.isLocalPortFree(localPort))) continue;
			try {
				handle = await this.openForwardTunnel({
					target: input.target,
					remotePort: input.remotePort,
					localPort,
				});
				break;
			} catch (cause) {
				lastFailure = cause;
				if (!retryableLocalBindFailure(cause)) throw cause;
			}
		}
		if (handle === null) throw lastFailure;
		const entry: ForwardEntry = {
			summary: {
				environmentId: input.environmentId,
				remotePort: input.remotePort,
				localPort: handle.localPort,
			},
			handle,
		};
		this.forwards.set(key, entry);
		handle.process.once("exit", () => {
			if (this.forwards.get(key) === entry) this.forwards.delete(key);
		});
		return entry.summary;
	}
}
