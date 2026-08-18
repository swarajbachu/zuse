import { describe, expect, it } from "vitest";

import { nextChatCreateCommandId } from "../../src/lib/chat-create-command-id.ts";

describe("chat create command identity", () => {
	it("uses a fresh command id for each attempt of one durable operation", () => {
		const operationId = "create_operation-1";
		const initialAttempt = nextChatCreateCommandId(operationId);
		const retryAttempt = nextChatCreateCommandId(operationId);

		expect(initialAttempt).not.toBe(retryAttempt);
		expect(initialAttempt).toMatch(
			/^chat-create:create_operation-1:[0-9a-f-]{36}$/,
		);
		expect(retryAttempt).toMatch(
			/^chat-create:create_operation-1:[0-9a-f-]{36}$/,
		);
	});
});
