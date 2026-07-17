import {
	AuthenticationError,
	CursorSdkError,
	NetworkError,
	RateLimitError,
} from "@cursor/sdk";
import { describe, expect, it } from "vitest";

import { classifyApiKeyValidationError } from "../../src/provider/api-key-validation.ts";

describe("API-key validation classification", () => {
	it.each([
		new AuthenticationError("Invalid API key"),
		new CursorSdkError("Unauthorized", { status: 401 }),
		new Error("API key was revoked"),
	])("rejects confirmed authentication failures", (error) => {
		expect(classifyApiKeyValidationError(error)).toEqual({
			status: "invalid",
			reason: "The API key was rejected. Check the key and try again.",
		});
	});

	it.each([
		new NetworkError("Network unavailable", { status: 503 }),
		new RateLimitError("Rate limited", { status: 429 }),
		new CursorSdkError("Server failure", { status: 500 }),
		new Error("Request timed out"),
		new Error("Unexpected SDK failure"),
	])("keeps non-authentication failures non-blocking", (error) => {
		expect(classifyApiKeyValidationError(error).status).toBe("unverified");
	});
});
