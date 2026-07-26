import { describe, expect, it } from "vitest";

import { redactDiagnosticValue } from "../../../src/lib/redact-diagnostics";

describe("voice diagnostic redaction", () => {
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
