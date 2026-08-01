import { describe, expect, test } from "vitest";

import { shouldRefreshSkillsForWatch } from "../../src/skill/skill-watch-filter.ts";

describe("skill watch filter", () => {
	test("ignores provider-managed system skill refreshes only", () => {
		expect(shouldRefreshSkillsForWatch("codex", ".system")).toBe(false);
		expect(shouldRefreshSkillsForWatch("codex", ".system/skill/SKILL.md")).toBe(
			false,
		);
		expect(shouldRefreshSkillsForWatch("codex", "custom/SKILL.md")).toBe(true);
		expect(shouldRefreshSkillsForWatch("claude", ".system/SKILL.md")).toBe(
			true,
		);
	});
});
