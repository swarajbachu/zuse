import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
	addChipEffect,
	chipExtensions,
} from "../../src/lib/codemirror/composer-chips.ts";
import { completesDoubleSpacePeriod } from "../../src/lib/codemirror/composer-period.ts";

const completes = (doc: string) =>
	completesDoubleSpacePeriod(
		EditorState.create({ doc, extensions: chipExtensions }),
		doc.length,
	);

describe("composer double-space period", () => {
	it("applies after a word, number or closing bracket", () => {
		expect(completes("hello ")).toBe(true);
		expect(completes("version 2 ")).toBe(true);
		expect(completes("(see docs) ")).toBe(true);
		expect(completes('he said "done" ')).toBe(true);
	});

	it("leaves space runs, punctuation and line starts alone", () => {
		expect(completes("")).toBe(false);
		expect(completes(" ")).toBe(false);
		expect(completes("hello")).toBe(false);
		expect(completes("hello  ")).toBe(false);
		expect(completes("hello. ")).toBe(false);
		expect(completes("hello, ")).toBe(false);
		expect(completes("line\n ")).toBe(false);
	});

	it("does not punctuate right after a chip", () => {
		const doc = "@src/app.ts ";
		const state = EditorState.create({
			doc,
			extensions: chipExtensions,
		}).update({
			effects: addChipEffect.of({
				from: 0,
				to: doc.length - 1,
				meta: {
					kind: "file",
					relPath: "src/app.ts",
					absPath: "/repo/src/app.ts",
					entryKind: "file",
				},
			}),
		}).state;
		expect(completesDoubleSpacePeriod(state, doc.length)).toBe(false);
	});
});
