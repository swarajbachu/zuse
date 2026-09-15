import { ExtensionError } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import { errorMessage } from "../../src/lib/error-message.ts";

describe("extension error presentation", () => {
	it("shows the typed failure reason when the Error message is empty", () => {
		const cause = new ExtensionError({
			code: "signature-failed",
			extensionId: null,
			reason: "Extension marketplace signature is invalid.",
		});
		expect(cause.message).toBe("");
		expect(errorMessage(cause, "Please retry.")).toBe(
			"Extension marketplace signature is invalid.",
		);
	});
	it.each([
		new Error(""),
		new Error("   "),
		null,
		undefined,
	])("never renders an empty error banner for %s", (cause) => {
		expect(errorMessage(cause, "Please retry.")).toBe("Please retry.");
	});
});
