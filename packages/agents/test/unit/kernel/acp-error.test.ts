import { describe, expect, it } from "vitest";

import { formatAcpError } from "../../../src/kernel/acp-error.ts";

describe("formatAcpError", () => {
	it("prefers structured detail and retains diagnostics", () => {
		expect(
			formatAcpError(
				{ code: -1, message: "Internal error", data: { reason: "signed out" } },
				{
					fallback: "failed",
					diagnostics: "stderr tail",
					appendDiagnostics: true,
				},
			),
		).toBe(
			"Internal error — signed out — Diagnostics:\nstderr tail — (code -1)",
		);
	});

	it("uses the fallback when the envelope and diagnostics are empty", () => {
		expect(formatAcpError({}, { fallback: "provider failed" })).toBe(
			"provider failed",
		);
	});
});
