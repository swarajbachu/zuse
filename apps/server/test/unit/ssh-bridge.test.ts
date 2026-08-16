import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { verifySshTicket } from "../../src/transports/ssh-bridge.ts";

const sha256Hex = (value: string): string =>
	createHash("sha256").update(value).digest("hex");

const NOW = 1_000_000;
const TICKET = "workspace_ssh_abc123";

const ticketFile = (overrides: Record<string, unknown> = {}): string =>
	JSON.stringify({
		tokenHash: sha256Hex(TICKET),
		expiresAtMs: NOW + 60_000,
		...overrides,
	});

describe("ssh bridge ticket verification", () => {
	test("accepts a matching, unexpired ticket", () => {
		expect(verifySshTicket(TICKET, ticketFile(), NOW)).toBe(true);
	});

	test("rejects a wrong ticket", () => {
		expect(verifySshTicket("workspace_ssh_other", ticketFile(), NOW)).toBe(
			false,
		);
	});

	test("rejects an expired ticket", () => {
		expect(
			verifySshTicket(TICKET, ticketFile({ expiresAtMs: NOW - 1 }), NOW),
		).toBe(false);
		expect(verifySshTicket(TICKET, ticketFile({ expiresAtMs: NOW }), NOW)).toBe(
			false,
		);
	});

	test("rejects malformed ticket files", () => {
		expect(verifySshTicket(TICKET, "not json", NOW)).toBe(false);
		expect(verifySshTicket(TICKET, "{}", NOW)).toBe(false);
		expect(verifySshTicket(TICKET, ticketFile({ tokenHash: 42 }), NOW)).toBe(
			false,
		);
		expect(
			verifySshTicket(TICKET, ticketFile({ tokenHash: "zz-not-hex" }), NOW),
		).toBe(false);
	});
});
