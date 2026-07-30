import { describe, expect, it } from "vitest";

import {
	sanitizeRemoteConnectionLog,
	sanitizeRemoteDiagnosticValue,
} from "../../src/remote-diagnostic-sanitizer.ts";

describe("remote diagnostic sanitizer", () => {
	it("redacts credentials in fields, nested values, and URLs", () => {
		const token = "private-auth-value";
		const sanitized = sanitizeRemoteDiagnosticValue({
			token,
			hasToken: true,
			request: {
				url: `ws://localhost/rpc?wireVersion=2&token=${token}`,
				authorization: `Bearer ${token}`,
			},
		});

		expect(JSON.stringify(sanitized)).not.toContain(token);
		expect(sanitized).toEqual({
			token: "[REDACTED]",
			hasToken: true,
			request: {
				url: "ws://localhost/rpc?wireVersion=2&token=[REDACTED]",
				authorization: "[REDACTED]",
			},
		});
	});

	it("scrubs historical JSON lines and malformed text without dropping entries", () => {
		const token = "old-private-auth-value";
		const contents = [
			JSON.stringify({
				event: "ws.request",
				url: `ws://localhost/rpc?ticket=${token}`,
			}),
			`connection failed: Bearer ${token}`,
			"",
		].join("\n");

		const sanitized = sanitizeRemoteConnectionLog(contents);

		expect(sanitized).not.toContain(token);
		expect(sanitized).toContain("ws.request");
		expect(sanitized).toContain("ticket=[REDACTED]");
		expect(sanitized).toContain("Bearer [REDACTED]");
		expect(sanitized.endsWith("\n")).toBe(true);
	});
});
