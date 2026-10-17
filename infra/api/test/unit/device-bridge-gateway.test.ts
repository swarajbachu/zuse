import type { DurableObjectState } from "@cloudflare/workers-types";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceBridgeGateway } from "../../src/device-bridge-gateway";

class Socket {
	readyState = 1;
	attachment: unknown;
	messages: string[] = [];
	serializeAttachment(value: unknown) {
		this.attachment = value;
	}
	deserializeAttachment() {
		return this.attachment;
	}
	send(value: string) {
		this.messages.push(value);
	}
	close() {
		this.readyState = 3;
	}
}
const setup = () => {
	const records = new Map<string, unknown>();
	const sockets: { socket: Socket; tags: string[] }[] = [];
	const storage = {
		get: async (key: string) => records.get(key),
		put: async (key: string, value: unknown) => {
			records.set(key, value);
		},
		list: async () => new Map(records),
		transaction: async (fn: (txn: unknown) => Promise<unknown>) => fn(storage),
		setAlarm: vi.fn(async () => {}),
	};
	const state = {
		storage,
		getWebSockets: (tag?: string) =>
			sockets
				.filter(
					(entry) =>
						entry.socket.readyState === 1 && (!tag || entry.tags.includes(tag)),
				)
				.map((entry) => entry.socket),
		acceptWebSocket: (socket: Socket, tags: string[]) =>
			sockets.push({ socket, tags }),
	};
	const NativeResponse = Response;
	vi.stubGlobal(
		"Response",
		class extends NativeResponse {
			constructor(body: BodyInit | null, init?: ResponseInit) {
				super(body, init?.status === 101 ? { ...init, status: 200 } : init);
			}
		},
	);
	vi.stubGlobal(
		"WebSocketPair",
		class {
			0 = new Socket();
			1 = new Socket();
		},
	);
	const gateway = new DeviceBridgeGateway(
		state as unknown as DurableObjectState,
	);
	const call = (
		path: string,
		body?: unknown,
		headers?: Record<string, string>,
	) =>
		gateway.fetch(
			new Request(`https://bridge.internal${path}`, {
				method: body === undefined ? "GET" : "POST",
				body: body === undefined ? undefined : JSON.stringify(body),
				headers,
			}),
		);
	return { gateway, call, sockets, records };
};
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
const enrollment = {
	deviceId: "mac",
	label: "MacBook Pro",
	secret: "a".repeat(64),
};
it("enrolls independently of remote sharing and preserves revoked enrollment", async () => {
	const { call } = setup();
	expect((await call("/enroll", enrollment)).status).toBe(200);
	expect(await (await call("/devices")).json()).toEqual([
		expect.objectContaining({
			deviceId: "mac",
			connected: false,
			revoked: false,
		}),
	]);
	expect(
		(await call("/enroll", { ...enrollment, secret: "b".repeat(64) })).status,
	).toBe(403);
	await call("/revoke?deviceId=mac", {});
	expect((await call("/enroll", enrollment)).status).toBe(403);
	expect((await call("/enroll", { ...enrollment, restore: true })).status).toBe(
		200,
	);
});
it("authenticates the device secret and fences replaced sockets and pending operations", async () => {
	const { call, sockets } = setup();
	await call("/enroll", enrollment);
	expect(
		(
			await call("/connect?deviceId=mac", undefined, {
				upgrade: "websocket",
				"x-zuse-device-secret": "wrong",
			})
		).status,
	).toBe(403);
	await call("/connect?deviceId=mac", undefined, {
		upgrade: "websocket",
		"x-zuse-device-secret": enrollment.secret,
	});
	const pending = call("/dispatch?deviceId=mac", {
		token: "signed",
		body: "{}",
	});
	await vi.waitFor(() => expect(sockets[0]?.socket.messages).toHaveLength(1));
	await call("/connect?deviceId=mac", undefined, {
		upgrade: "websocket",
		"x-zuse-device-secret": enrollment.secret,
	});
	expect((await pending).status).toBe(503);
	expect(sockets[0]?.socket.readyState).toBe(3);
	expect(await (await call("/devices")).json()).toEqual([
		expect.objectContaining({ connected: true }),
	]);
});
it("does not report sleeping or expired sockets as connected", async () => {
	vi.useFakeTimers();
	const { call, gateway } = setup();
	await call("/enroll", enrollment);
	await call("/connect?deviceId=mac", undefined, {
		upgrade: "websocket",
		"x-zuse-device-secret": enrollment.secret,
	});
	vi.setSystemTime(Date.now() + 46000);
	expect(await (await call("/devices")).json()).toEqual([
		expect.objectContaining({ connected: false }),
	]);
	expect(
		(await call("/dispatch?deviceId=mac", { token: "signed", body: "{}" }))
			.status,
	).toBe(503);
	await gateway.alarm();
});
it("revocation immediately closes the bridge without changing remote-access state", async () => {
	const { call, sockets } = setup();
	await call("/enroll", enrollment);
	await call("/connect?deviceId=mac", undefined, {
		upgrade: "websocket",
		"x-zuse-device-secret": enrollment.secret,
	});
	await call("/revoke?deviceId=mac", {});
	expect(sockets[0]?.socket.readyState).toBe(3);
	expect(
		(
			await call("/connect?deviceId=mac", undefined, {
				upgrade: "websocket",
				"x-zuse-device-secret": enrollment.secret,
			})
		).status,
	).toBe(403);
});

it("does not restore access when revocation happens during a connection's credential check", async () => {
	const { call, sockets } = setup();
	await call("/enroll", enrollment);
	const digest = crypto.subtle.digest.bind(crypto.subtle);
	let finish!: () => void;
	const paused = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const spy = vi
		.spyOn(crypto.subtle, "digest")
		.mockImplementation(async (...args) => {
			await paused;
			return digest(...args);
		});
	try {
		const connecting = call("/connect?deviceId=mac", undefined, {
			upgrade: "websocket",
			"x-zuse-device-secret": enrollment.secret,
		});
		await call("/revoke?deviceId=mac", {});
		finish();
		expect((await connecting).status).toBe(403);
		expect(sockets).toHaveLength(0);
		expect(await (await call("/devices")).json()).toEqual([
			expect.objectContaining({ revoked: true, connected: false }),
		]);
	} finally {
		finish();
		spy.mockRestore();
	}
});
