import { describe, expect, test } from "vitest";

import { normalizeApiError } from "../../../src/rpc/api-errors";

describe("api client errors", () => {
	test("hides Cloudflare html bodies for transient connect failures", () => {
		const html =
			'<!DOCTYPE html><html><head><title>Worker threw exception</title></head><body style="margin:0;padding:0">Cloudflare<script>if (!navigator.cookieEnabled) { window.addEventListener("DOMContentLoaded", function () {}) }</script></body></html>';

		expect(normalizeApiError(500, html, "api_connect")).toBe("api_connect_500");
	});

	test("hides plain bodies for api rate limits and server errors", () => {
		expect(
			normalizeApiError(
				500,
				"Worker threw exception | api.zuse.sh | Cloudflare body{margin:0}",
				"api_connect",
			),
		).toBe("api_connect_500");
		expect(normalizeApiError(429, "try again later", "api_connect")).toBe(
			"api_connect_429",
		);
	});

	test("keeps useful json errors for non-transient failures", () => {
		expect(
			normalizeApiError(
				401,
				JSON.stringify({ error: "invalid_dpop_proof" }),
				"api_connect",
			),
		).toBe("api_connect_401:invalid_dpop_proof");
	});

	test("keeps safe machine errors for server failures", () => {
		expect(
			normalizeApiError(
				500,
				JSON.stringify({ error: "internal_error" }),
				"api_connect",
			),
		).toBe("api_connect_500:internal_error");
	});
});
