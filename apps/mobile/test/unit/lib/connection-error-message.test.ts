import { describe, expect, test } from "vitest";

import { connectionErrorMessage } from "../../../src/lib/connection-error-message";

describe("connection error message", () => {
	test("turns native socket timeouts into recovery guidance", () => {
		expect(
			connectionErrorMessage(
				new Error('SocketOpenError: timeout waiting for "open"'),
			),
		).toBe("Could not reach this computer. Check that it is online and retry.");
	});

	test("does not expose relay machine codes", () => {
		expect(connectionErrorMessage("relay_connect_500:internal_error")).toBe(
			"Relay is temporarily unavailable. Try again in a moment.",
		);
	});
});
