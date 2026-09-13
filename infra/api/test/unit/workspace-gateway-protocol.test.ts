import {
	decodeWorkspaceGatewayFrame,
	encodeWorkspaceGatewayFrame,
	MAX_WORKSPACE_GATEWAY_PAYLOAD_BYTES,
	workspaceGatewayArrayBuffer,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import {
	decodeGatewayMessage,
	encodeGatewayMessage,
	WORKSPACE_GATEWAY_AUTH_EXPIRED_CLOSE,
	WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE,
	WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE,
	WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE,
	WORKSPACE_GATEWAY_UPDATE_REQUIRED_CLOSE,
} from "../../src/workspace-gateway-protocol.ts";

describe("workspace gateway protocol", () => {
	it("round-trips control messages", () => {
		const message = {
			type: "client.open" as const,
			connectionId: "client-1",
		};
		expect(decodeGatewayMessage(encodeGatewayMessage(message))).toEqual(
			message,
		);
	});

	it("rejects malformed or unknown messages", () => {
		expect(decodeGatewayMessage("not-json")).toBeNull();
		expect(decodeGatewayMessage('{"type":"client.open"}')).toBeNull();
		expect(
			decodeGatewayMessage(
				'{"type":"client.frame","connectionId":"client-1","payload":"legacy"}',
			),
		).toBeNull();
		expect(
			decodeGatewayMessage('{"type":"workspace.status","phase":"paused"}'),
		).toBeNull();
		expect(decodeGatewayMessage('{"type":"future.message"}')).toBeNull();
	});

	it("uses a stable application close code when no runtime is available", () => {
		expect(WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE).toEqual({
			code: 4100,
			reason: "workspace runtime unavailable",
		});
	});

	it("assigns stable typed close codes to every reconnect class", () => {
		expect([
			WORKSPACE_GATEWAY_RUNTIME_UNAVAILABLE_CLOSE,
			WORKSPACE_GATEWAY_STALE_GENERATION_CLOSE,
			WORKSPACE_GATEWAY_AUTH_EXPIRED_CLOSE,
			WORKSPACE_GATEWAY_UPDATE_REQUIRED_CLOSE,
			WORKSPACE_GATEWAY_BACKPRESSURE_CLOSE,
		]).toEqual([
			{ code: 4100, reason: "workspace runtime unavailable" },
			{ code: 4101, reason: "workspace generation changed" },
			{ code: 4102, reason: "workspace authorization expired" },
			{ code: 4103, reason: "client update required" },
			{ code: 4104, reason: "workspace gateway backpressure" },
		]);
	});

	it("round-trips opaque binary frames without base64 expansion", () => {
		const bytes = Uint8Array.from([0, 1, 2, 127, 128, 255]);
		const encoded = encodeWorkspaceGatewayFrame({
			direction: "runtime",
			connectionId: "client-1",
			payload: bytes.buffer,
		});
		const decoded = decodeWorkspaceGatewayFrame(encoded);
		expect(decoded).toMatchObject({
			direction: "runtime",
			connectionId: "client-1",
		});
		expect(new Uint8Array(decoded?.payload as ArrayBuffer)).toEqual(bytes);
		expect(encoded.byteLength).toBeLessThan(
			JSON.stringify([...bytes]).length + 64,
		);
	});

	it("preserves text encoding and exact ArrayBufferView bounds", () => {
		const backing = Uint8Array.from([99, 4, 5, 6, 88]);
		const exact = workspaceGatewayArrayBuffer(backing.subarray(1, 4));
		expect([...new Uint8Array(exact)]).toEqual([4, 5, 6]);

		const decoded = decodeWorkspaceGatewayFrame(
			encodeWorkspaceGatewayFrame({
				direction: "client",
				connectionId: "unicode-λ",
				payload: "hello 👋",
			}),
		);
		expect(decoded).toEqual({
			direction: "client",
			connectionId: "unicode-λ",
			payload: "hello 👋",
		});
	});

	it("rejects malformed and oversized envelopes", () => {
		expect(decodeWorkspaceGatewayFrame(new ArrayBuffer(0))).toBeNull();
		const valid = new Uint8Array(
			encodeWorkspaceGatewayFrame({
				direction: "client",
				connectionId: "client-1",
				payload: "rpc",
			}),
		);
		valid[5] = 9;
		expect(decodeWorkspaceGatewayFrame(valid.buffer)).toBeNull();
		expect(() =>
			encodeWorkspaceGatewayFrame({
				direction: "client",
				connectionId: "client-1",
				payload: new ArrayBuffer(MAX_WORKSPACE_GATEWAY_PAYLOAD_BYTES + 1),
			}),
		).toThrow("too large");
	});
});
