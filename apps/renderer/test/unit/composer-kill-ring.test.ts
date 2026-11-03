import { history, undo } from "@codemirror/commands";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
	killWith,
	yank,
	yankPop,
} from "../../src/lib/codemirror/composer-kill-ring.ts";

const editor = (doc: string, anchor = doc.length): EditorView => {
	const view = {
		state: EditorState.create({
			doc,
			selection: { anchor },
			extensions: history(),
		}),
		dispatch(spec: TransactionSpec) {
			view.state = view.state.update(spec).state;
		},
	};
	return view as unknown as EditorView;
};

const deleteRange =
	(from: number, to: number): Command =>
	(view) => {
		view.dispatch({ changes: { from, to } });
		return true;
	};

describe("composer kill ring", () => {
	it("pastes back the last deletion and cycles older ones", () => {
		const view = editor("alpha beta gamma");
		killWith(deleteRange(11, 16))(view);
		killWith(deleteRange(6, 11))(view);
		expect(view.state.doc.toString()).toBe("alpha ");

		expect(yank(view)).toBe(true);
		expect(view.state.doc.toString()).toBe("alpha beta ");
		expect(yankPop(view)).toBe(true);
		expect(view.state.doc.toString()).toBe("alpha gamma");
	});

	it("only cycles straight after a paste", () => {
		const view = editor("one two");
		killWith(deleteRange(3, 7))(view);
		killWith(deleteRange(0, 3))(view);
		yank(view);
		view.dispatch({ changes: { from: 0, insert: "x" } });
		expect(yankPop(view)).toBe(false);
	});

	it("leaves Ctrl+Y to redo when there is something to redo", () => {
		const view = editor("keep");
		killWith(deleteRange(0, 4))(view);
		view.dispatch({ changes: { from: 0, insert: "a" }, userEvent: "input" });
		undo(view);
		expect(yank(view)).toBe(false);
	});
});
