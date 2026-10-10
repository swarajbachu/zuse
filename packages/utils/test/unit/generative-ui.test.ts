import { describe, expect, it } from "vitest";

import {
	generativeUiComponentLines,
	generativeUiComponentNames,
	generativeUiJsonSchema,
	UI_SPEC_MAX_CHARS,
	UI_SPEC_VERSION,
	validateGenerativeUiSpec,
} from "../../src/generative-ui.ts";

describe("generative UI spec", () => {
	it("exposes the stable component catalogue", () => {
		expect(generativeUiComponentNames).toEqual([
			"Card",
			"Text",
			"Stat",
			"KeyValue",
			"Table",
			"Progress",
			"Badge",
			"List",
		]);
		expect(UI_SPEC_VERSION).toBe(1);
	});

	it("produces a $defs-keyed JSON schema for the lang-core parser", () => {
		const schema = generativeUiJsonSchema();
		expect(Object.keys(schema.$defs).sort()).toEqual(
			[...generativeUiComponentNames].sort(),
		);
		expect(schema.$defs.Stat).toMatchObject({
			type: "object",
			required: ["label", "value"],
		});
	});

	it("renders positional signatures for the tool description", () => {
		const lines = generativeUiComponentLines();
		expect(lines).toContain(
			"Stat(label: string, value: string, hint?: string)",
		);
		expect(lines).toContain("Table(columns: string[], rows: string[][])");
		expect(lines).toContain(
			'Badge(label: string, tone?: "neutral" | "good" | "warn" | "bad")',
		);
		expect(lines).toContain(
			"KeyValue(pairs: { key: string, value: string }[])",
		);
	});

	it("accepts a valid spec", () => {
		const spec = [
			'root = Card([s1, t1], "Status")',
			's1 = Stat("Downloads", "12k")',
			't1 = Table(["Name", "Result"], [["build", "ok"],["lint", "ok"]])',
		].join("\n");
		expect(validateGenerativeUiSpec(spec)).toEqual({ ok: true });
	});

	it("rejects empty and oversized specs", () => {
		expect(validateGenerativeUiSpec("").ok).toBe(false);
		expect(validateGenerativeUiSpec("   ").ok).toBe(false);
		expect(validateGenerativeUiSpec("x".repeat(UI_SPEC_MAX_CHARS + 1)).ok).toBe(
			false,
		);
	});

	it("rejects specs with no resolvable root", () => {
		const validation = validateGenerativeUiSpec("not a spec at all !!!");
		expect(validation.ok).toBe(false);
		if (!validation.ok) expect(validation.error.length).toBeGreaterThan(0);
	});

	it("rejects unknown components with a fixable error", () => {
		const validation = validateGenerativeUiSpec('root = Confetti("yay")');
		expect(validation.ok).toBe(false);
		if (!validation.ok) {
			expect(validation.error).toContain("Confetti");
			expect(validation.error).toContain("Card");
		}
	});

	it("rejects unresolved references", () => {
		const validation = validateGenerativeUiSpec("root = Card([missing])");
		expect(validation.ok).toBe(false);
		if (!validation.ok) expect(validation.error).toContain("missing");
	});

	it("rejects Query()/Mutation() statements — emit_ui is display-only", () => {
		const validation = validateGenerativeUiSpec(
			'q = Query("list_issues")\nroot = Text("hi")',
		);
		expect(validation.ok).toBe(false);
		if (!validation.ok) expect(validation.error).toContain("Query()");
	});
});
