import { describe, expect, test } from "vitest";

import { normalizeRelayError } from "../../../src/rpc/relay-errors";

describe("relay client errors", () => {
	test("hides Cloudflare html bodies for transient connect failures", () => {
		const html =
			'<!DOCTYPE html><html><head><title>Worker threw exception</title></head><body style="margin:0;padding:0">Cloudflare<script>if (!navigator.cookieEnabled) { window.addEventListener("DOMContentLoaded", function () {}) }</script></body></html>';

		expect(normalizeRelayError(500, html, "relay_connect")).toBe(
			"relay_connect_500",
		);
	});

	test("hides plain bodies for relay rate limits and server errors", () => {
		expect(
			normalizeRelayError(
				500,
				"Worker threw exception | relay.stuff.md | Cloudflare body{margin:0}",
				"relay_connect",
			),
		).toBe("relay_connect_500");
		expect(normalizeRelayError(429, "try again later", "relay_connect")).toBe(
			"relay_connect_429",
		);
	});

	test("keeps useful json errors for non-transient failures", () => {
		expect(
			normalizeRelayError(
				401,
				JSON.stringify({ error: "invalid_dpop_proof" }),
				"relay_connect",
			),
		).toBe("relay_connect_401:invalid_dpop_proof");
	});

	test("keeps safe machine errors for server failures", () => {
		expect(
			normalizeRelayError(
				500,
				JSON.stringify({ error: "internal_error" }),
				"relay_connect",
			),
		).toBe("relay_connect_500:internal_error");
	});
});
