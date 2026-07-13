import { describe, expect, test } from "vitest";

import { decidePermission } from "../../../src/kernel/permission-policy.js";

describe("decidePermission", () => {
	test.each([
		["approval-required", "read", false, "allow"],
		["approval-required", "edit", false, "prompt"],
		["auto-accept-edits", "edit", false, "allow"],
		["auto-accept-edits", "execute", false, "prompt"],
		["auto-accept-edits-and-bash", "execute", false, "allow"],
		["auto-accept-edits-and-bash", "network", false, "prompt"],
		["full-access", "network", false, "allow"],
		["full-access", "edit", true, "prompt"],
	] as const)("maps %s / %s / sensitive=%s to %s", (runtimeMode, category, sensitive, expected) => {
		expect(
			decidePermission({
				runtimeMode,
				permissionMode: "default",
				category,
				sensitive,
			}),
		).toBe(expected);
	});

	test("keeps plan mode read-only, denies mutations, and prompts only to exit", () => {
		expect(
			decidePermission({
				runtimeMode: "full-access",
				permissionMode: "plan",
				category: "read",
				sensitive: false,
			}),
		).toBe("allow");
		expect(
			decidePermission({
				runtimeMode: "full-access",
				permissionMode: "plan",
				category: "execute",
				sensitive: false,
			}),
		).toBe("deny");
		expect(
			decidePermission({
				runtimeMode: "full-access",
				permissionMode: "plan",
				category: "exit-plan",
				sensitive: false,
			}),
		).toBe("prompt");
	});

	test("respects a provider that cannot request interactive permission", () => {
		expect(
			decidePermission({
				runtimeMode: "approval-required",
				permissionMode: "default",
				category: "execute",
				sensitive: false,
				canPrompt: false,
			}),
		).toBe("deny");
	});
});
