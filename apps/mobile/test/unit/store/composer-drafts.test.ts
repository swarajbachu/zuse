import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	clearComposerDraft,
	composerDraft,
	composerDraftAtom,
	draftsBySessionAtom,
	setComposerDraft,
} from "../../../src/store/composer-drafts";
import { appAtomRegistry } from "../../../src/store/registry";

describe("session-keyed composer drafts", () => {
	beforeEach(() => {
		appAtomRegistry.set(draftsBySessionAtom, {});
	});

	it("keeps drafts independent while switching threads", () => {
		setComposerDraft("connection:planning", {
			text: "Investigate first",
			attachments: [],
			goalMode: false,
		});
		setComposerDraft("connection:build", {
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
		setComposerDraft("one", { text: "one", attachments: [], goalMode: false });
		setComposerDraft("two", { text: "two", attachments: [], goalMode: false });
		clearComposerDraft("one");

		expect(composerDraft("one").text).toBe("");
		expect(composerDraft("two").text).toBe("two");
	});

	it("only notifies subscribers of the session that changed", () => {
		const onPlanning = vi.fn();
		// immediate: true builds the node so the dependency edge to the base
		// record exists — mirroring how the React hooks read atoms on mount.
		const unsubscribe = appAtomRegistry.subscribe(
			composerDraftAtom("connection:planning"),
			onPlanning,
			{ immediate: true },
		);
		expect(onPlanning).toHaveBeenCalledTimes(1);

		setComposerDraft("connection:build", {
			text: "Unrelated",
			attachments: [],
			goalMode: false,
		});
		expect(onPlanning).toHaveBeenCalledTimes(1);

		setComposerDraft("connection:planning", {
			text: "Relevant",
			attachments: [],
			goalMode: false,
		});
		expect(onPlanning).toHaveBeenCalledTimes(2);
		unsubscribe();
	});
});
