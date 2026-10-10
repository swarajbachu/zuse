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
			"Grid",
			"BarChart",
			"LineChart",
			"FollowUps",
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

describe("saved UI safety and chart data", () => {
	it("accepts responsive dashboards with both chart types", () => {
		expect(
			validateGenerativeUiSpec(`root = Card([Grid([Stat("Builds", "42"), Progress("Passing", 100)], 2), trend, comparison], "CI health")
trend = LineChart("Duration", [{label: "Mon", value: 12}, {label: "Tue", value: 9}], "s")
comparison = BarChart("Change", [{label: "Build", value: -3}, {label: "Test", value: 2}])`),
		).toEqual({ ok: true });
	});
	it.each([
		'root = Progress("Done", 101)',
		'root = Progress("Done", -1)',
		'root = Grid([Text("Hi")], 2.5)',
		'root = Grid([Text("Hi")], 5)',
		'root = Table(["A", "B"], [["one"]])',
		"root = Table([], [])",
		'root = BarChart("Empty", [])',
		'root = LineChart("Invalid", [{label: "x", value: "bad"}])',
		'root = Card(["not a component"])',
		'root = Badge("State", "unknown")',
		'root = Text("Hello")\nroot = Text("Goodbye")',
		'$value = "Hi"\nroot = Text($value)',
		'root = Text(If(true, "yes", "no"))',
		'm = Mutation("delete")\nroot = Text("Hi")',
		"root = Card([root])",
		'root = Card([Text("incomplete")',
		"root = FollowUps([])",
		'root = FollowUps([{label: "", prompt: "Go"}])',
		'root = FollowUps([{label: "Go"}])',
		`root = FollowUps([${Array.from({ length: 7 }, () => '{label: "a", prompt: "b"}').join(",")}])`,
	])("rejects invalid or dynamic input: %s", (spec) => {
		expect(validateGenerativeUiSpec(spec).ok).toBe(false);
	});
	it("rejects exponential reference expansion before materializing it", () => {
		const parts = ['leaf = Text("hi")'];
		for (let index = 0; index < 30; index++) {
			const previous = index === 0 ? "leaf" : `node${index - 1}`;
			parts.push(`node${index} = Card([${previous}, ${previous}])`);
		}
		parts.push("root = Card([node29])");
		const result = validateGenerativeUiSpec(parts.join("\n"));
		expect(result).toMatchObject({
			ok: false,
			error: expect.stringContaining("too complex"),
		});
	});
	it("rejects excessive chart and container data", () => {
		const points = Array.from({ length: 101 }, (_, index) => ({
			label: String(index),
			value: index,
		}));
		expect(
			validateGenerativeUiSpec(
				`root = LineChart("Too many", ${JSON.stringify(points)})`,
			).ok,
		).toBe(false);
		expect(
			validateGenerativeUiSpec(
				`root = Card([${Array.from({ length: 65 }, () => 'Text("x")').join(",")}])`,
			).ok,
		).toBe(false);
	});
	it("accepts follow-up prompts alongside a dashboard", () => {
		expect(
			validateGenerativeUiSpec(`root = Card([Stat("Failing", "2"), next], "Tests")
next = FollowUps([{label: "Fix failures", prompt: "Fix the two failing tests."}, {label: "Explain", prompt: "Explain why they fail."}])`),
		).toEqual({ ok: true });
	});
	it("treats tool-looking strings as inert text", () => {
		expect(
			validateGenerativeUiSpec(
				'root = Text("Query() Mutation() $state <script>alert(1)</script>")',
			),
		).toEqual({ ok: true });
	});
});

it("rejects unused components instead of silently losing output", () => {
	expect(
		validateGenerativeUiSpec('unused = Text("Lost output")\nroot = Text("Hi")'),
	).toMatchObject({
		ok: false,
		error: expect.stringContaining("Unused statements"),
	});
});
