import { describe, expect, it } from "vitest";

import { summarizeDiagnosticArguments } from "../../src/lib/diagnostics-recorder.ts";

describe("diagnostics recorder", () => {
	it("records console argument metadata without serializing values", () => {
		const summary = summarizeDiagnosticArguments([
			"private prompt",
			{ terminalOutput: "secret output" },
			new Error("Bearer secret-token"),
		]);

		expect(summary).toBe("argumentTypes=string,object,Error count=3");
		expect(summary).not.toContain("private prompt");
		expect(summary).not.toContain("secret output");
		expect(summary).not.toContain("secret-token");
	});
});
