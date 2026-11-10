import { describe, expect, it } from "vitest";

import { redactDiagnosticValue } from "../../../src/lib/redact-diagnostics";

describe("voice diagnostic redaction", () => {
	it("preserves JSON timestamps while redacting nested secrets", () => {
		expect(
			redactDiagnosticValue({
				retryAt: new Date(0),
				nested: [
					{ expiresAt: new Date("2026-10-24T00:00:00Z"), token: "private" },
				],
				invalidDate: new Date(Number.NaN),
			}),
		).toEqual({
			retryAt: "1970-01-01T00:00:00.000Z",
			nested: [{ expiresAt: "2026-10-24T00:00:00.000Z", token: "[redacted]" }],
			invalidDate: null,
		});
	});
	it("recursively excludes tokens and authorization material", () => {
		const redacted = redactDiagnosticValue({
			ticket: "safe-ticket",
			nested: {
				token: "secret-token",
				authorization: "Bearer secret",
				message: "safe",
			},
		});
		expect(JSON.stringify(redacted)).not.toContain("secret-token");
		expect(JSON.stringify(redacted)).not.toContain("Bearer secret");
		expect(redacted).toMatchObject({
			ticket: "safe-ticket",
			nested: {
				token: "[redacted]",
				authorization: "[redacted]",
				message: "safe",
			},
		});
	});
});
