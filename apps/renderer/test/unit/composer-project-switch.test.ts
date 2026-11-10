import { ComposerInput, EnvironmentId, FolderId } from "@zuse/contracts";
import { beforeEach, expect, it } from "vitest";
import { finalizeDraftAttachments } from "../../src/composer/draft-attachments.ts";
import {
	composerDraftKeyForLanding,
	composerDraftKeyForNewChat,
	useComposerDraftsStore,
} from "../../src/store/composer-drafts.ts";

beforeEach(() =>
	useComposerDraftsStore.setState({ draftsByKey: {}, contextsByKey: {} }),
);
it("keeps the image file with a draft across project switches so it can still be sent", async () => {
	const environment = EnvironmentId.make("local");
	const first = composerDraftKeyForLanding(environment, FolderId.make("first"));
	const second = composerDraftKeyForLanding(
		environment,
		FolderId.make("second"),
	);
	const file = new File([new Uint8Array([1, 2, 3])], "draft.png", {
		type: "image/png",
	});
	const pendingAttachments = [
		{ tempId: "pending-image", file, previewUrl: "blob:preview" },
	];
	const snapshot = {
		doc: "keep this [image:pending-image]",
		chips: [],
		pendingAttachments,
	};
	useComposerDraftsStore.getState().save(first, snapshot);
	useComposerDraftsStore
		.getState()
		.save(second, { doc: "other project", chips: [] });
	const restored = useComposerDraftsStore.getState().draftsByKey[first];
	expect(restored).toMatchObject({ doc: snapshot.doc, pendingAttachments });
	const pending = (restored as typeof snapshot).pendingAttachments;
	const input = ComposerInput.make({
		text: "keep this",
		attachments: [
			{ id: "pending-image", mimeType: file.type, originalName: file.name },
		],
		fileRefs: [],
		skillRefs: [],
	});
	const sent = await finalizeDraftAttachments(input, pending, async (item) => {
		expect(await item.file.arrayBuffer()).toEqual(await file.arrayBuffer());
		return {
			id: "uploaded-image",
			mimeType: file.type,
			originalName: file.name,
		};
	});
	expect(sent.attachments[0]?.id).toBe("uploaded-image");
});

it("keeps a new-chat composition while changing its project but isolates computers and workspaces", () => {
	const environment = EnvironmentId.make("local");
	const key = composerDraftKeyForNewChat(environment);
	useComposerDraftsStore
		.getState()
		.save(key, { doc: "draft for the selected project", chips: [] });
	// The project picker remounts the composer with the same new-chat key.
	expect(
		useComposerDraftsStore.getState().draftsByKey[
			composerDraftKeyForNewChat(environment)
		]?.doc,
	).toBe("draft for the selected project");
	expect(composerDraftKeyForNewChat(EnvironmentId.make("other"))).not.toBe(key);
	expect(
		composerDraftKeyForNewChat(environment, {
			kind: "organization",
			organizationId: "org",
		}),
	).not.toBe(key);
});
it("retains pasted context files alongside image files", () => {
	const key = composerDraftKeyForNewChat(EnvironmentId.make("local"));
	const pendingContextFiles = [
		{
			tempRelPath: ".context/files/paste-pending-test.md",
			text: "long paste",
			ext: "md",
		},
	];
	useComposerDraftsStore.getState().save(key, {
		doc: "@.context/files/paste-pending-test.md",
		chips: [],
		pendingContextFiles,
	});
	expect(
		useComposerDraftsStore.getState().draftsByKey[key]?.pendingContextFiles,
	).toEqual(pendingContextFiles);
});
