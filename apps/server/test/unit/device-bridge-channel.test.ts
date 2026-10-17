import { afterEach, expect, it, vi } from "vitest";
import { DesktopBridgeChannel } from "../../src/device-bridge/channel";

class Socket {
	static OPEN = 1;
	static instances: Socket[] = [];
	readyState = 0;
	onopen?: () => void;
	onclose?: () => void;
	onerror?: () => void;
	onmessage?: (event: { data: string }) => Promise<void>;
	sent: string[] = [];
	constructor(
		readonly url: URL,
		readonly protocols: string[],
	) {
		Socket.instances.push(this);
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
	close() {
		this.readyState = 3;
		this.onclose?.();
	}
	send(data: string) {
		this.sent.push(data);
	}
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	Socket.instances = [];
});
const identity = {
	accountId: "account",
	deviceId: "mac",
	label: "Mac",
	secret: "a".repeat(64),
	token: "account-token",
};
const setup = () => {
	vi.useFakeTimers();
	const fetch = vi.fn(async (_url: string, _options: RequestInit) =>
		Response.json({ mintPublicKey: "key", apiIssuer: "https://api.test" }),
	);
	vi.stubGlobal("fetch", fetch);
	vi.stubGlobal("WebSocket", Socket);
	return { fetch };
};
it("enrolls without remote sharing and cleans up all timers on stop", async () => {
	const { fetch } = setup();
	const channel = new DesktopBridgeChannel({
		apiUrl: "https://api.test",
		identity: async () => identity,
		receive: async () => ({}),
	});
	channel.start();
	await vi.advanceTimersByTimeAsync(0);
	expect(fetch.mock.calls[0]?.[0]).toBe(
		"https://api.test/v1/device-bridge/enroll",
	);
	const socket = Socket.instances[0];
	expect(socket).toBeDefined();
	socket?.open();
	expect(channel.snapshot()).toMatchObject({
		connected: true,
		accountId: "account",
	});
	channel.stop();
	expect(channel.snapshot().connected).toBe(false);
	expect(vi.getTimerCount()).toBe(0);
});
it("never enrolls when signed out or disabled", async () => {
	const { fetch } = setup();
	const channel = new DesktopBridgeChannel({
		apiUrl: "https://api.test",
		identity: async () => null,
		receive: async () => ({}),
	});
	channel.start();
	await vi.advanceTimersByTimeAsync(0);
	expect(fetch).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
	channel.stop();
});
it("does not automatically restore a remotely revoked device", async () => {
	const { fetch } = setup();
	fetch.mockResolvedValue(new Response(null, { status: 403 }));
	const channel = new DesktopBridgeChannel({
		apiUrl: "https://api.test",
		identity: async () => identity,
		receive: async () => ({}),
	});
	channel.start();
	await vi.advanceTimersByTimeAsync(60000);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(Socket.instances).toHaveLength(0);
	expect(channel.snapshot().error).toContain("revoked");
	channel.stop();
});
it("discards command responses after the account channel has stopped", async () => {
	setup();
	let resolve!: (value: unknown) => void;
	const channel = new DesktopBridgeChannel({
		apiUrl: "https://api.test",
		identity: async () => identity,
		receive: () =>
			new Promise((done) => {
				resolve = done;
			}),
	});
	channel.start();
	await vi.advanceTimersByTimeAsync(0);
	const socket = Socket.instances[0];
	socket?.open();
	const pending = socket?.onmessage?.({
		data: JSON.stringify({
			type: "request",
			id: "request",
			token: "signed",
			body: "{}",
		}),
	});
	channel.stop();
	resolve({});
	await pending;
	expect(socket?.sent).toEqual([]);
	expect(vi.getTimerCount()).toBe(0);
});
