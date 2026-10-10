import { Deferred, Effect, Fiber } from "effect";
import { Socket } from "effect/unstable/socket";
import { describe, expect, test, vi } from "vitest";
import {
	cloudGatewaySocket,
	needsCloudGatewayReadiness,
} from "../../src/cloud-gateway-socket.ts";

class TestSocket extends EventTarget {
	readyState = 0;
	deferClose = false;
	sent: unknown[] = [];
	close = vi.fn((code = 1000, reason = "") => {
		this.readyState = 2;
		if (!this.deferClose) this.finishClose(code, reason);
	});
	finishClose(code = 1000, reason = "") {
		this.readyState = 3;
		this.dispatchEvent(new CloseEvent("close", { code, reason }));
	}
	send(data: unknown) {
		this.sent.push(data);
	}
	open() {
		this.readyState = 1;
		this.dispatchEvent(new Event("open"));
	}
	message(data: unknown) {
		this.dispatchEvent(new MessageEvent("message", { data }));
	}
	availability(state: "pending" | "available", reset = false) {
		this.message(
			JSON.stringify({ _zuseGateway: "availability", state, reset }),
		);
	}
}

describe("pending cloud gateway transport", () => {
	test("opens RPC only after guest attachment and never buffers mutations", () => {
		const native = new TestSocket();
		const socket = cloudGatewaySocket(native as unknown as WebSocket);
		const opened = vi.fn();
		const received = vi.fn();
		socket.addEventListener("open", opened, { once: true });
		socket.addEventListener("message", received);
		native.open();
		native.availability("pending");
		expect(socket.readyState).toBe(0);
		expect(opened).not.toHaveBeenCalled();
		expect(() => socket.send("mutation")).toThrow("pending");
		expect(native.sent).toEqual([]);
		native.availability("available");
		expect(socket.readyState).toBe(1);
		expect(opened).toHaveBeenCalledTimes(1);
		expect(received).not.toHaveBeenCalled();
		socket.send("handshake");
		native.message("rpc-response");
		expect(native.sent).toEqual(["handshake"]);
		expect(received).toHaveBeenCalledTimes(1);
		native.availability("available");
		expect(native.close).not.toHaveBeenCalled();
	});
	test("rebuilds established RPC immediately when its runtime disappears without replaying frames", () => {
		const native = new TestSocket();
		const socket = cloudGatewaySocket(native as unknown as WebSocket);
		native.open();
		native.availability("available");
		socket.send("first");
		native.availability("pending");
		expect(() => socket.send("second")).not.toThrow();
		expect(native.close).toHaveBeenCalledWith(
			4100,
			"workspace runtime unavailable",
		);
		expect(native.sent).toEqual(["first"]);
	});
	test("Effect Socket gates its writer initially and reports established loss as typed close, including a write racing asynchronous native closure", async () => {
		const native = new TestSocket();
		native.deferClose = true;
		await Effect.runPromise(
			Effect.gen(function* () {
				const opened = yield* Deferred.make<void>();
				const socket = yield* Socket.fromWebSocket(
					Effect.succeed(cloudGatewaySocket(native as unknown as WebSocket)),
				);
				const reader = yield* socket
					.runRaw(() => {}, {
						onOpen: Deferred.succeed(opened, undefined).pipe(Effect.asVoid),
					})
					.pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
				const write = yield* socket.writer;
				const initial = yield* write("handshake").pipe(
					Effect.forkScoped({ startImmediately: true }),
				);
				yield* Effect.yieldNow;
				native.open();
				native.availability("pending");
				expect(native.sent).toEqual([]);
				native.availability("available");
				yield* Deferred.await(opened);
				yield* Fiber.join(initial);
				expect(native.sent).toEqual(["handshake"]);
				native.availability("pending");
				expect(native.readyState).toBe(2);
				// Native close is asynchronous; no send defect or frame can escape meanwhile.
				yield* write("racing-mutation").pipe(
					Effect.forkScoped({ startImmediately: true }),
				);
				expect(native.sent).toEqual(["handshake"]);
				const result = yield* Fiber.join(reader).pipe(
					Effect.timeout("100 millis"),
				);
				expect(result).toMatchObject({
					_tag: "Failure",
					failure: {
						_tag: "SocketError",
						reason: { _tag: "SocketCloseError", code: 4100 },
					},
				});
			}).pipe(Effect.scoped),
		);
	});
	test("removes wrapped listeners and only gates negotiated v3 connections", () => {
		const native = new TestSocket();
		const socket = cloudGatewaySocket(native as unknown as WebSocket);
		const listener = vi.fn();
		socket.addEventListener("message", listener);
		socket.removeEventListener("message", listener);
		native.message("rpc");
		expect(listener).not.toHaveBeenCalled();
		expect(needsCloudGatewayReadiness(["zuse-workspace-v3"])).toBe(true);
		expect(needsCloudGatewayReadiness("zuse-workspace-v2")).toBe(false);
	});
	test.each([
		"pending",
		"available",
	] as const)("reports %s retirement once without waiting for or faking native close", (state) => {
		const native = new TestSocket();
		native.deferClose = true;
		const nativeClosed = vi.fn();
		native.addEventListener("close", nativeClosed);
		const socket = cloudGatewaySocket(native as unknown as WebSocket);
		const once = vi.fn();
		const persistent = vi.fn();
		const removed = vi.fn();
		const received = vi.fn();
		socket.addEventListener("close", once, { once: true });
		socket.addEventListener("close", persistent);
		socket.addEventListener("close", removed);
		socket.removeEventListener("close", removed);
		socket.addEventListener("message", received);
		native.open();
		native.availability("available");
		native.availability(state, state === "available");
		expect(socket.readyState).toBe(3);
		expect(native.readyState).toBe(2);
		expect(once).toHaveBeenCalledTimes(1);
		expect(persistent).toHaveBeenCalledTimes(1);
		expect(once.mock.calls[0]?.[0]).toMatchObject({
			code: 4100,
			reason: "workspace runtime unavailable",
		});
		expect(removed).not.toHaveBeenCalled();
		expect(nativeClosed).not.toHaveBeenCalled();
		native.message("obsolete-rpc-response");
		native.availability("available", true);
		expect(received).not.toHaveBeenCalled();
		expect(native.close).toHaveBeenCalledTimes(1);
		native.finishClose(1006, "");
		expect(nativeClosed).toHaveBeenCalledTimes(1);
		expect(once).toHaveBeenCalledTimes(1);
		expect(persistent).toHaveBeenCalledTimes(1);
	});
});
