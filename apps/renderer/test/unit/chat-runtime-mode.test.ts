import type { RepositorySettings } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import { effectiveChatRuntimeMode } from "../../src/lib/auto-worktree.ts";

describe("effectiveChatRuntimeMode", () => {
	it("uses a repository permission override for new chats", () => {
		expect(
			effectiveChatRuntimeMode("approval-required", {
				defaultRuntimeMode: "full-access",
			} as RepositorySettings),
		).toBe("full-access");
	});

	it("falls back to the global permission default", () => {
		expect(
			effectiveChatRuntimeMode("auto-accept-edits", {
				defaultRuntimeMode: null,
			} as RepositorySettings),
		).toBe("auto-accept-edits");
		expect(effectiveChatRuntimeMode("approval-required", null)).toBe(
			"approval-required",
		);
	});
});
