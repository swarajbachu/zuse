import * as FileSystem from "expo-file-system/legacy";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-file-system/legacy", () => ({
	documentDirectory: "file:///test/",
	makeDirectoryAsync: vi.fn(async () => undefined),
	writeAsStringAsync: vi.fn(async () => undefined),
	deleteAsync: vi.fn(async () => undefined),
	getInfoAsync: vi.fn(async () => ({ exists: false })),
	readAsStringAsync: vi.fn(async () => "{}"),
}));

import {
	clearComposerDraft,
	clearComposerDrafts,
	composerDraft,
	composerDraftAtom,
	draftsBySessionAtom,
	persistComposerDraft,
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

describe("reset composer data", () => {
	it("removes both draft and protected attachment roots and clears memory", async () => {
		await persistComposerDraft("reset-test", {
			text: "private draft",
			attachments: [],
			goalMode: false,
		});
		await clearComposerDrafts();
		expect(composerDraft("reset-test").text).toBe("");
		expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
			"file:///test/zuse-composer-drafts",
			{ idempotent: true },
		);
		expect(FileSystem.deleteAsync).toHaveBeenCalledWith(
			"file:///test/zuse-outbox-media",
			{ idempotent: true },
		);
	});
	it("drains an in-flight save before deletion and rejects writes during reset", async () => {
		let finish!: () => void;
		vi.mocked(FileSystem.writeAsStringAsync).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const saving = persistComposerDraft("pending", {
			text: "secret",
			attachments: [],
			goalMode: false,
		});
		await vi.waitFor(() => expect(finish).toBeDefined());
		const clearing = clearComposerDrafts();
		setComposerDraft("stale-ui", {
			text: "must not return",
			attachments: [],
			goalMode: false,
		});
		finish();
		await saving;
		await clearing;
		expect(appAtomRegistry.get(draftsBySessionAtom)).toEqual({});
		const writes = vi.mocked(FileSystem.writeAsStringAsync).mock
			.invocationCallOrder;
		const deletes = vi.mocked(FileSystem.deleteAsync).mock.invocationCallOrder;
		expect(writes.at(-1)).toBeLessThan(deletes.at(-1) ?? 0);
	});
});
