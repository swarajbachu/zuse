import type { EditorView } from "@codemirror/view";
import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import { resolveAttachmentUrl } from "../lib/attachments.ts";
import {
	allChips,
	updateImageChipEffect,
} from "../lib/codemirror/composer-chips.ts";

/** Both queue editing and history recall read images from their owning session. */
export const hydrateComposerImagePreviews = (
	view: EditorView,
	ref: SessionRef,
	isCurrent: () => boolean,
): void => {
	for (const chip of allChips(view.state)) {
		const meta = chip.meta;
		if (
			meta.kind !== "image" ||
			!meta.mimeType.startsWith("image/") ||
			meta.id.startsWith("pending-")
		)
			continue;
		void resolveAttachmentUrl(ref, meta.id)
			.then((previewUrl) => {
				if (!isCurrent()) return;
				view.dispatch({
					effects: updateImageChipEffect.of({
						previousId: meta.id,
						meta: { ...meta, previewUrl },
					}),
				});
			})
			.catch(() => undefined);
	}
};
