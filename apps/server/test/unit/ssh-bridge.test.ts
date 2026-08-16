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

	test.each([
		["wrong ticket", "workspace_ssh_other", ticketFile()],
		["expired ticket", TICKET, ticketFile({ expiresAtMs: NOW })],
		["invalid JSON", TICKET, "not json"],
		["missing fields", TICKET, "{}"],
		["invalid hash type", TICKET, ticketFile({ tokenHash: 42 })],
		["invalid hash", TICKET, ticketFile({ tokenHash: "zz-not-hex" })],
	])("rejects %s", (_case, ticket, contents) => {
		expect(verifySshTicket(ticket, contents, NOW)).toBe(false);
	});
});
