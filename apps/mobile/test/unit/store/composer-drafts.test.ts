import { beforeEach, describe, expect, it } from "vitest";

import {
	composerDraft,
	useComposerDraftsStore,
} from "../../../src/store/composer-drafts";

describe("session-keyed composer drafts", () => {
	beforeEach(() => {
		useComposerDraftsStore.setState({ draftsBySession: {} });
	});

	it("keeps drafts independent while switching threads", () => {
		const { setDraft } = useComposerDraftsStore.getState();
		setDraft("connection:planning", {
			text: "Investigate first",
			attachments: [],
			goalMode: false,
		});
		setDraft("connection:build", {
			text: "Ship the fix",
			attachments: [],
			goalMode: true,
		});

		expect(composerDraft("connection:planning").text).toBe("Investigate first");
		expect(composerDraft("connection:build")).toMatchObject({
			text: "Ship the fix",
			goalMode: true,
		});
	});

	it("clears only the submitted thread", () => {
		const state = useComposerDraftsStore.getState();
		state.setDraft("one", { text: "one", attachments: [], goalMode: false });
		state.setDraft("two", { text: "two", attachments: [], goalMode: false });
		state.clearDraft("one");

		expect(composerDraft("one").text).toBe("");
		expect(composerDraft("two").text).toBe("two");
	});
});
