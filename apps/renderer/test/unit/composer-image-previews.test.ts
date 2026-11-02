import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { EnvironmentId, SessionId } from "@zuse/contracts";
import { expect, it, vi } from "vitest";
import { hydrateComposerImagePreviews } from "../../src/composer/image-previews.ts";
import { resolveAttachmentUrl } from "../../src/lib/attachments.ts";
import {
	addChipEffect,
	allChips,
	chipExtensions,
} from "../../src/lib/codemirror/composer-chips.ts";

vi.mock("../../src/lib/attachments.ts", () => ({
	resolveAttachmentUrl: vi.fn(),
}));
const ref = {
	environmentId: EnvironmentId.make("remote-test"),
	sessionId: SessionId.make("image-session"),
};
it("hydrates a recalled image with its session-qualified preview", async () => {
	const state = EditorState.create({
		doc: "image",
		extensions: chipExtensions,
	}).update({
		effects: addChipEffect.of({
			from: 0,
			to: 5,
			meta: {
				kind: "image",
				id: "image-id",
				mimeType: "image/png",
				originalName: "test.png",
				previewUrl: "",
			},
		}),
	}).state;
	const view = { state, dispatch: vi.fn() } as unknown as EditorView;
	vi.mocked(resolveAttachmentUrl).mockResolvedValueOnce(
		"data:image/png;base64,test",
	);
	hydrateComposerImagePreviews(view, ref, () => true);
	await vi.waitFor(() => expect(view.dispatch).toHaveBeenCalledOnce());
	expect(resolveAttachmentUrl).toHaveBeenLastCalledWith(ref, "image-id");
	const transaction = vi.mocked(view.dispatch).mock.calls[0]?.[0];
	if (!transaction) throw new Error("missing preview transaction");
	expect(allChips(state.update(transaction).state)[0]?.meta).toMatchObject({
		previewUrl: "data:image/png;base64,test",
	});
});
it("does not mutate an editor after switching away", async () => {
	const state = EditorState.create({
		doc: "image",
		extensions: chipExtensions,
	}).update({
		effects: addChipEffect.of({
			from: 0,
			to: 5,
			meta: {
				kind: "image",
				id: "image-id",
				mimeType: "image/png",
				originalName: "test.png",
				previewUrl: "",
			},
		}),
	}).state;
	const view = { state, dispatch: vi.fn() } as unknown as EditorView;
	vi.mocked(resolveAttachmentUrl).mockResolvedValueOnce(
		"data:image/png;base64,test",
	);
	hydrateComposerImagePreviews(view, ref, () => false);
	await Promise.resolve();
	await Promise.resolve();
	expect(view.dispatch).not.toHaveBeenCalled();
});
