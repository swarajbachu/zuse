import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
	addChipEffect,
	allChips,
	chipExtensions,
	removeImageChipEffect,
} from "../../src/lib/codemirror/composer-chips.ts";

describe("composer image chips", () => {
	it("removes a failed pending upload from the document and chip state", () => {
		const token = "[image:pending-upload]";
		let state = EditorState.create({
			doc: token,
			extensions: chipExtensions,
		});
		state = state.update({
			effects: addChipEffect.of({
				from: 0,
				to: token.length,
				meta: {
					kind: "image",
					id: "pending-upload",
					mimeType: "image/png",
					originalName: "image.png",
					previewUrl: "blob:test",
				},
			}),
		}).state;

		const [chip] = allChips(state);
		expect(chip).toBeDefined();
		state = state.update({
			changes: { from: chip?.from ?? 0, to: chip?.to ?? 0 },
			effects: removeImageChipEffect.of({ id: "pending-upload" }),
		}).state;

		expect(state.doc.toString()).toBe("");
		expect(allChips(state)).toEqual([]);
	});
});
