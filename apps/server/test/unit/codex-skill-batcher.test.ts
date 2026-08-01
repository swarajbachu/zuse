import { describe, expect, test, vi } from "vitest";

import { createCodexSkillBatcher } from "../../src/skill/codex-skill-batcher.ts";

describe("Codex skill batcher", () => {
	test("coalesces adjacent projects and preserves per-project results", async () => {
		vi.useFakeTimers();
		const list = vi.fn(async (cwds: ReadonlyArray<string>) =>
			cwds.map((cwd) => ({ cwd, skills: [`skill:${cwd}`] })),
		);
		const batcher = createCodexSkillBatcher(list, 25);

		const first = batcher.load("/one");
		const second = batcher.load("/two");
		const duplicate = batcher.load("/one");
		await vi.advanceTimersByTimeAsync(25);

		await expect(Promise.all([first, second, duplicate])).resolves.toEqual([
			["skill:/one"],
			["skill:/two"],
			["skill:/one"],
		]);
		expect(list).toHaveBeenCalledOnce();
		expect(list).toHaveBeenCalledWith(["/one", "/two"]);
		vi.useRealTimers();
	});
});
