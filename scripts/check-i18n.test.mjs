import assert from "node:assert/strict";
import { test } from "node:test";
import {
	findLiteralCopy,
	sourceRevision,
	validateMessage,
	validatePlurals,
} from "./check-i18n.mjs";

test("interpolation may reorder, but may not drop or invent values", () => {
	assert.equal(
		validateMessage(
			"{{name}} has {{count}} files",
			"{{count}} fichiers pour {{name}}",
		),
		null,
	);
	assert.match(validateMessage("{{name}}", "{{nom}}"), /placeholders/);
	assert.match(validateMessage("{{name}}", "Bonjour"), /placeholders/);
});
test("rich messages only use supplied components without translator-controlled props", () => {
	assert.equal(
		validateMessage(
			"Open <part0>{{path}}</part0>",
			"<part0>{{path}}</part0>を開く",
		),
		null,
	);
	assert.match(
		validateMessage(
			"<part0>Open</part0>",
			'<part0 href="https://evil.test">Open</part0>',
		),
		/attributes/,
	);
	assert.match(
		validateMessage("<part0>Open</part0>", "</part0>Open<part0>"),
		/unbalanced/,
	);
	assert.match(validateMessage("Open", "<script>Open</script>"), /markup/);
});
test("source revisions are stable under ordering and change with copy", () => {
	assert.equal(
		sourceRevision({ a: { one: "one", two: "two" } }),
		sourceRevision({ a: { two: "two", one: "one" } }),
	);
	assert.notEqual(
		sourceRevision({ a: { one: "one" } }),
		sourceRevision({ a: { one: "changed" } }),
	);
});
test("the literal check covers accessible names, fallbacks, and dynamic sentences", () => {
	const found = findLiteralCopy(
		"fixture.tsx",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Source fixture contains a literal template.
		'const UI = () => <button aria-label="Open">{label ?? "Untitled"}{`Delete ${count} files`}</button>;',
	);
	assert.deepEqual(
		found.map((item) => item.text),
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Expected source text, not interpolation.
		["Open", "Untitled", "`Delete ${count} files`"],
	);
	assert.deepEqual(
		findLiteralCopy(
			"fixture.tsx",
			'const UI = () => <button className="h-7">{message("common:open")}</button>;',
		),
		[],
	);
});

test("plural validation requires locale-specific categories and permits their keys", () => {
	const source = {
		items_one: "{{count}} item",
		items_other: "{{count}} items",
	};
	assert.match(validatePlurals(source, source, "fr").join(), /items_many/);
	assert.deepEqual(
		validatePlurals(
			source,
			{ ...source, items_many: "{{count}} articles" },
			"fr",
		),
		[],
	);
	assert.deepEqual(
		validatePlurals(source, { items_other: "{{count}}件" }, "ja"),
		[],
	);
	assert.match(
		validatePlurals(
			source,
			{ ...source, items_few: "{{count}} items" },
			"de",
		).join(),
		/obsolete/,
	);
});

test("native menu and dialog display strings are checked without flagging diagnostics", () => {
	assert.deepEqual(
		findLiteralCopy(
			"apps/desktop/src/main.ts",
			'dialog.showMessageBox({ message: "Stop agents?", buttons: ["Cancel"] }); console.log("diagnostic");',
		).map((item) => item.text),
		["Stop agents?", "Cancel"],
	);
	assert.deepEqual(
		findLiteralCopy(
			"apps/desktop/src/menu.ts",
			'const menu = { label: "Settings" };',
		).map((item) => item.text),
		["Settings"],
	);
});

test("checks custom accessibility props while ignoring embedded CSS", () => {
	assert.deepEqual(
		findLiteralCopy(
			"control.tsx",
			'<><Control ariaLabel="Choose environment" /><style>{`body { color: red; }`}</style></>',
		).map(({ text }) => text),
		["Choose environment"],
	);
});
