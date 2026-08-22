import { EventEmitter } from "node:events";
import type { TunnelHandle } from "@zuse/ssh";
import { describe, expect, it } from "vitest";

import {
	PortForwardManager,
	type PortForwardTarget,
	retryableLocalBindFailure,
} from "../../src/tunnels/port-forward-service.ts";

const sshTarget: PortForwardTarget = {
	kind: "ssh",
	target: { alias: "devbox", hostname: "devbox", username: null, port: null },
};

type FakeProcess = EventEmitter & {
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
};

const fakeTunnel = (
	localPort: number,
	remotePort: number,
): { handle: TunnelHandle; process: FakeProcess; closed: () => boolean } => {
	const process = Object.assign(new EventEmitter(), {
		exitCode: null,
		signalCode: null,
	}) as FakeProcess;
	let closed = false;
	const handle = {
		localPort,
		remotePort,
		process,
		wsBaseUrl: `ws://127.0.0.1:${localPort}/rpc`,
		close: async () => {
			closed = true;
			process.exitCode = 0;
			process.emit("exit", 0, null);
		},
	} as unknown as TunnelHandle;
	return { handle, process, closed: () => closed };
};

describe("PortForwardManager", () => {
	it("retries port bind failures but not SSH access failures", () => {
		expect(retryableLocalBindFailure(new Error("bind failed"))).toBe(true);
		expect(
			retryableLocalBindFailure(new Error("zuse ssh bridge: access rejected")),
		).toBe(false);
	});

	it("prefers the remote port locally and is idempotent while alive", async () => {
		const opened: number[] = [];
		const manager = new PortForwardManager(
			async (input) => {
				opened.push(input.localPort);
				return fakeTunnel(input.localPort, input.remotePort).handle;
			},
			async () => true,
		);
		const first = await manager.open({
			environmentId: "env-a",
			target: sshTarget,
			remotePort: 3000,
		});
		const second = await manager.open({
			environmentId: "env-a",
			target: sshTarget,
			remotePort: 3000,
		});
		expect(first).toEqual({
			environmentId: "env-a",
			remotePort: 3000,
			localPort: 3000,
		});
		expect(second).toBe(first);
		expect(opened).toEqual([3000]);
	});

	it("falls back to a random local port when the preferred one is taken", async () => {
		const manager = new PortForwardManager(
			async (input) => fakeTunnel(input.localPort, input.remotePort).handle,
			async (port) => port !== 3000,
		);
		const forward = await manager.open({
			environmentId: "env-a",
			target: sshTarget,
			remotePort: 3000,
		});
		expect(forward.localPort).not.toBe(3000);
		expect(forward.localPort).toBeGreaterThanOrEqual(20_000);
	});

	it("retries once on a random port when the preferred bind is lost", async () => {
		const attempts: number[] = [];
		const manager = new PortForwardManager(
			async (input) => {
				attempts.push(input.localPort);
				if (attempts.length === 1) throw new Error("bind failed");
				return fakeTunnel(input.localPort, input.remotePort).handle;
			},
			async () => true,
		);
		const forward = await manager.open({
			environmentId: "env-a",
			target: sshTarget,
			remotePort: 3000,
		});
		expect(attempts[0]).toBe(3000);
		expect(forward.localPort).not.toBe(3000);
	});

	it("bounds verified allocation retries across repeated port collisions", async () => {
		const attempts: number[] = [];
		let candidate = 20_000;
		const manager = new PortForwardManager(
			async (input) => {
				attempts.push(input.localPort);
				throw new Error("bind failed");
			},
			async () => true,
			() => candidate++,
		);
		await expect(
			manager.open({
				environmentId: "env-a",
				target: sshTarget,
				remotePort: 3000,
			}),
		).rejects.toThrow("bind failed");
		expect(attempts).toEqual([3000, 20_000, 20_001, 20_002, 20_003]);
	});

	it("evicts dead tunnels and reopens on the next request", async () => {
		let openCount = 0;
		const processes: FakeProcess[] = [];
		const manager = new PortForwardManager(
			async (input) => {
				openCount += 1;
				const tunnel = fakeTunnel(input.localPort, input.remotePort);
				processes.push(tunnel.process);
				return tunnel.handle;
			},
			async () => true,
		);
		await manager.open({
			environmentId: "env-a",
			target: sshTarget,
			remotePort: 3000,
		});
		processes.at(-1)?.emit("exit", 1, null);
		expect(manager.list("env-a")).toEqual([]);
		await manager.open({
			environmentId: "env-a",
			target: sshTarget,
			remotePort: 3000,
		});
		expect(openCount).toBe(2);
	});

	it("closes every forward that belongs to an environment", async () => {
		const manager = new PortForwardManager(
			async (input) => fakeTunnel(input.localPort, input.remotePort).handle,
			async () => true,
		);
		await manager.open({
			environmentId: "env-a",
			target: sshTarget,
			remotePort: 3000,
		});
		await manager.open({
			environmentId: "env-a",
			target: sshTarget,
			remotePort: 8080,
		});
		await manager.open({
			environmentId: "env-b",
			target: sshTarget,
			remotePort: 5173,
		});
		await manager.closeForEnvironment("env-a");
		expect(manager.list("env-a")).toEqual([]);
		expect(manager.list("env-b")).toHaveLength(1);
		await manager.closeAll();
		expect(manager.list()).toEqual([]);
	});

	it("closes an in-flight forward when its environment disconnects", async () => {
		let resolveOpen: (handle: TunnelHandle) => void = () => undefined;
		let markOpenStarted: () => void = () => undefined;
		const openStarted = new Promise<void>((resolve) => {
			markOpenStarted = resolve;
		});
		const tunnel = fakeTunnel(3000, 3000);
		const manager = new PortForwardManager(
			() =>
				new Promise<TunnelHandle>((resolve) => {
					resolveOpen = resolve;
					markOpenStarted();
				}),
			async () => true,
		);
		const opening = manager.open({
			environmentId: "env-a",
			target: sshTarget,
			remotePort: 3000,
		});
		await openStarted;
		const closing = manager.closeForEnvironment("env-a");
		resolveOpen(tunnel.handle);
		await closing;
		await expect(opening).rejects.toThrow("closed before it became ready");
		expect(tunnel.closed()).toBe(true);
		expect(manager.list("env-a")).toEqual([]);
	});
});
