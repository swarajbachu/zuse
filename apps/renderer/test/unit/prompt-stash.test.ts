import { beforeEach, describe, expect, it } from "vitest";

import { uniqueRecallEntries } from "../../src/components/composer/history-search-popover.tsx";
import {
	MAX_STASHED_PROMPTS,
	usePromptStash,
} from "../../src/store/prompt-stash.ts";

describe("prompt stash", () => {
	beforeEach(() => {
		for (const entry of usePromptStash.getState().entries)
			usePromptStash.getState().remove(entry.id);
	});

	it("keeps the newest prompts first and caps the list", () => {
		for (let i = 0; i < MAX_STASHED_PROMPTS + 2; i++)
			usePromptStash.getState().stash({ doc: `prompt ${i}`, chips: [] });
		const { entries } = usePromptStash.getState();
		expect(entries).toHaveLength(MAX_STASHED_PROMPTS);
		expect(entries[0]?.doc).toBe(`prompt ${MAX_STASHED_PROMPTS + 1}`);
	});

	it("drops image preview URLs, which do not survive a reload", () => {
		usePromptStash.getState().stash({
			doc: "[image:a1]",
			chips: [
				{
					from: 0,
					to: 10,
					meta: {
						kind: "image",
						id: "a1",
						mimeType: "image/png",
						originalName: "shot.png",
						previewUrl: "blob:x",
					},
				},
			],
		});
		const chip = usePromptStash.getState().entries[0]?.chips[0];
		expect(chip?.meta.kind === "image" && chip.meta.previewUrl).toBe("");
	});
});

describe("message search entries", () => {
	it("lists newest first without repeats or empty drafts", () => {
		const entry = (at: number, doc: string) => ({
			at,
			snapshot: { doc, chips: [] },
		});
		expect(
			uniqueRecallEntries([
				entry(1, "fix the tests"),
				entry(2, "   "),
				entry(3, "deploy it"),
				entry(4, "fix  the tests"),
			]).map((e) => e.text),
		).toEqual(["fix the tests", "deploy it"]);
	});
});
