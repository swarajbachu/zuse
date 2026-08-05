import { runtimeModeForProvider } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import {
	MODE_META,
	MODES_ORDER,
	runtimeModesForProvider,
} from "../../src/components/runtime-mode-meta.ts";

describe("runtime mode metadata", () => {
	it("surfaces the risk-reviewed mode in the permission stack", () => {
		expect(runtimeModesForProvider("codex")).toEqual([
			"approval-required",
			"auto-accept-edits",
			"auto-accept-edits-and-bash",
			"auto",
			"full-access",
		]);
		expect(MODE_META.auto.label).toBe("Approve for me");
		expect(runtimeModesForProvider("claude")).toEqual(MODES_ORDER);
	});

	it("keeps the old shell preset readable for persisted sessions", () => {
		expect(MODE_META["auto-accept-edits-and-bash"].label).toContain("Bash");
	});

	it("falls back to supervised approval when leaving Codex", () => {
		expect(runtimeModeForProvider("auto", "codex")).toBe("auto");
		expect(runtimeModeForProvider("auto", "claude")).toBe("approval-required");
		expect(runtimeModeForProvider("full-access", "claude")).toBe("full-access");
	});
});
