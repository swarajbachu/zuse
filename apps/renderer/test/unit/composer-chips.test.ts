import { history, redo, undo } from "@codemirror/commands";
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

describe("composer chip undo", () => {
	const token = "@src/app.ts";
	const meta = {
		kind: "file",
		relPath: "src/app.ts",
		absPath: "/repo/src/app.ts",
		entryKind: "file",
	} as const;

	it("restores a deleted chip on undo and drops it again on redo", () => {
		let state = EditorState.create({
			doc: `see ${token} now`,
			extensions: [history(), chipExtensions],
		});
		state = state.update({
			effects: addChipEffect.of({ from: 4, to: 4 + token.length, meta }),
		}).state;
		state = state.update({
			changes: { from: 4, to: 4 + token.length },
			userEvent: "delete",
		}).state;
		expect(allChips(state)).toEqual([]);

		state = undoState(state);
		expect(state.doc.toString()).toBe(`see ${token} now`);
		expect(allChips(state)).toEqual([{ from: 4, to: 4 + token.length, meta }]);

		state = redoState(state);
		expect(state.doc.toString()).toBe("see  now");
		expect(allChips(state)).toEqual([]);
	});

	it("brings an inserted chip back on redo", () => {
		let state = EditorState.create({
			doc: "see ",
			extensions: [history(), chipExtensions],
		});
		state = state.update({
			changes: { from: 4, insert: `${token} ` },
			effects: addChipEffect.of({ from: 4, to: 4 + token.length, meta }),
			userEvent: "input",
		}).state;
		state = undoState(state);
		expect(allChips(state)).toEqual([]);
		state = redoState(state);
		expect(allChips(state)).toEqual([{ from: 4, to: 4 + token.length, meta }]);
	});
});

const runCommand = (state: EditorState, command: typeof undo): EditorState => {
	let next = state;
	command({
		state,
		dispatch: (tr) => {
			next = tr.state;
		},
	});
	return next;
};
const undoState = (state: EditorState) => runCommand(state, undo);
const redoState = (state: EditorState) => runCommand(state, redo);
