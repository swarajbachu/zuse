import { describe, expect, it } from "vitest";

import {
	AUTOMATIC_UPDATE_RETRY_DELAYS_MS,
	automaticUpdateRetryDelay,
	isTransientUpdateCheckError,
	updateCheckErrorMessage,
} from "../../src/updater-errors.ts";

describe("desktop updater errors", () => {
	it.each([
		408, 425, 429, 500, 502, 503, 504,
	])("classifies HTTP %i as transient", (status) => {
		expect(
			isTransientUpdateCheckError(
				new Error(`HttpError: ${status} while reading releases/latest`),
			),
		).toBe(true);
	});

	it.each([
		"ECONNRESET",
		"ENETUNREACH",
		"ETIMEDOUT",
		"EAI_AGAIN",
	])("classifies %s as transient", (code) => {
		expect(isTransientUpdateCheckError(new Error(code))).toBe(true);
	});

	it("does not classify integrity failures as transient", () => {
		expect(
			isTransientUpdateCheckError(
				new Error("Downloaded update has an invalid signature"),
			),
		).toBe(false);
	});

	it("uses bounded retry backoff", () => {
		expect(AUTOMATIC_UPDATE_RETRY_DELAYS_MS).toEqual([15_000, 60_000, 300_000]);
		expect(automaticUpdateRetryDelay(0)).toBe(15_000);
		expect(automaticUpdateRetryDelay(2)).toBe(300_000);
		expect(automaticUpdateRetryDelay(3)).toBeNull();
	});

	it("does not expose raw transport responses to the UI", () => {
		const message = updateCheckErrorMessage(
			new Error(
				"HttpError: 504 Data: <html><body><h1>Gateway Time-out</h1></body></html>",
			),
		);
		expect(message).toBe(
			"GitHub is temporarily unavailable. Try again in a moment.",
		);
		expect(message).not.toContain("<html>");
	});
});
