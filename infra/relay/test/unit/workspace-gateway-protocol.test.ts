import { describe, expect, it } from "vitest";
import {
	decodeGatewayFrame,
	decodeGatewayMessage,
	encodeGatewayFrame,
	encodeGatewayMessage,
} from "../../src/workspace-gateway-protocol.ts";

describe("workspace gateway protocol", () => {
	it("round-trips control messages", () => {
		const message = {
			type: "client.frame" as const,
			connectionId: "client-1",
			encoding: "text" as const,
			payload: "rpc-frame",
		};
		expect(decodeGatewayMessage(encodeGatewayMessage(message))).toEqual(
			message,
		);
	});

	it("rejects malformed or unknown messages", () => {
		expect(decodeGatewayMessage("not-json")).toBeNull();
		expect(decodeGatewayMessage('{"type":"client.frame"}')).toBeNull();
		expect(decodeGatewayMessage('{"type":"future.message"}')).toBeNull();
	});

	it("round-trips binary frames without changing bytes", () => {
		const bytes = Uint8Array.from([0, 1, 2, 127, 128, 255]);
		const encoded = encodeGatewayFrame(bytes.buffer);
		expect(encoded.encoding).toBe("base64");
		expect(new Uint8Array(decodeGatewayFrame(encoded) as ArrayBuffer)).toEqual(
			bytes,
		);
	});
});
