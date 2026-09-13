import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	CloudRuntimeCommand,
	CloudRuntimeCommandAck,
} from "../../src/cloud-api.ts";

describe("CloudRuntimeCommandAck", () => {
	it("accepts both upgraded and pre-turn-id runtime acknowledgements", () => {
		const decode = Schema.decodeUnknownSync(CloudRuntimeCommandAck);
		expect(
			decode({
				messageId: "message-1",
				turnId: "turn-original",
				commandTurnId: "turn-message-1",
			}),
		).toEqual({
			messageId: "message-1",
			turnId: "turn-original",
			commandTurnId: "turn-message-1",
		});
		expect(decode({ messageId: "message-legacy" })).toEqual({
			messageId: "message-legacy",
		});
	});
});

describe("CloudRuntimeCommand", () => {
	it("decodes a pre-turn-id API command during a rolling upgrade", () => {
		expect(
			Schema.decodeUnknownSync(CloudRuntimeCommand)({
				messageId: "message-legacy",
				commandId: "api:message-legacy",
				sessionId: "session-1",
				text: "continue",
				seq: 2,
			}),
		).toEqual({
			messageId: "message-legacy",
			commandId: "api:message-legacy",
			sessionId: "session-1",
			text: "continue",
			seq: 2,
		});
	});
});
