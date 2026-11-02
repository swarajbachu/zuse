import { describe, expect, it } from "vitest";
import { ComposerMessageHistory } from "../../src/composer/message-history.ts";
import type { ComposerDraftSnapshot } from "../../src/store/composer-drafts.ts";

const snapshot = (doc: string): ComposerDraftSnapshot => ({ doc, chips: [] });

describe("composer message history", () => {
	it("recalls newest first and restores the unsent draft", () => {
		const history = new ComposerMessageHistory();
		const first = snapshot("first");
		const second = snapshot("second");
		const messages = [first, second];
		const draft = snapshot("unfinished draft");
		expect(history.navigate(-1, draft, messages)).toEqual(messages[1]);
		expect(history.unsentDraft).toBe(draft);
		expect(history.navigate(-1, second, messages)).toEqual(messages[0]);
		expect(history.navigate(-1, first, messages)).toBeNull();
		expect(history.navigate(1, first, messages)).toEqual(messages[1]);
		expect(history.navigate(1, second, messages)).toBe(draft);
		expect(history.unsentDraft).toBeNull();
		expect(history.navigate(1, draft, messages)).toBeNull();
	});

	it("keeps attachments and a stable history when messages arrive", () => {
		const history = new ComposerMessageHistory();
		const rich: ComposerDraftSnapshot = {
			doc: "@src/app.ts",
			chips: [
				{
					from: 0,
					to: 11,
					meta: {
						kind: "file",
						relPath: "src/app.ts",
						absPath: "/repo/src/app.ts",
						entryKind: "file",
					},
				},
			],
		};
		const first = snapshot("first");
		expect(history.navigate(-1, rich, [first])).toBe(first);
		expect(history.navigate(1, first, [first, snapshot("arrived")])).toBe(rich);
	});

	it("resets after editing or sending and does not cross chat instances", () => {
		const history = new ComposerMessageHistory();
		const messages = [snapshot("old")];
		history.navigate(-1, snapshot(""), messages);
		history.reset();
		expect(history.navigate(1, snapshot("edited"), messages)).toBeNull();
		expect(
			new ComposerMessageHistory().navigate(-1, snapshot(""), []),
		).toBeNull();
	});
});
