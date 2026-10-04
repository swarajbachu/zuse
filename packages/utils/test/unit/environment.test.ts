import { describe, expect, test } from "vitest";
import {
	createSecretMasker,
	type EnvironmentBinding,
	environmentAssignmentConflict,
	parseEnvironmentFile,
	selectEnvironmentBindings,
	validateEnvironmentBindings,
} from "../../src/environment.ts";

const entry = (
	id: string,
	overrides: Partial<EnvironmentBinding> = {},
): EnvironmentBinding => ({
	id,
	name: "DATABASE_URL",
	scope: "personal",
	projectIds: null,
	excludedProjectIds: [],
	target: "both",
	...overrides,
});
describe("environment selection", () => {
	test("project-specific values do not leak across projects", () => {
		const entries = [
			entry("default"),
			entry("a", { projectIds: ["a"] }),
			entry("b", { projectIds: ["b"] }),
		];
		validateEnvironmentBindings(entries);
		expect(
			selectEnvironmentBindings(entries, "a", "local").map((x) => x.id),
		).toEqual(["a"]);
		expect(
			selectEnvironmentBindings(entries, "b", "cloud").map((x) => x.id),
		).toEqual(["b"]);
		expect(
			selectEnvironmentBindings(entries, "future", "local").map((x) => x.id),
		).toEqual(["default"]);
	});
	test("uses specific before default, personal before team; shared execution excludes personal", () => {
		const entries = [
			entry("personal"),
			entry("team", { scope: "team", projectIds: ["a"] }),
			entry("override", { projectIds: ["a"] }),
		];
		expect(
			selectEnvironmentBindings(entries, "a", "local").map((x) => x.id),
		).toEqual(["override"]);
		expect(
			selectEnvironmentBindings(entries.slice(0, 2), "a", "local").map(
				(x) => x.id,
			),
		).toEqual(["team"]);
		expect(
			selectEnvironmentBindings(entries, "a", "local", true).map((x) => x.id),
		).toEqual(["team"]);
	});
	test("exclusions and cloud-only values", () => {
		const entries = [
			entry("default", { excludedProjectIds: ["a"] }),
			entry("cloud", { name: "DEPLOY", target: "cloud" }),
		];
		expect(selectEnvironmentBindings(entries, "a", "local")).toEqual([]);
		expect(
			selectEnvironmentBindings(entries, "a", "cloud").map((x) => x.id),
		).toEqual(["cloud"]);
	});
	test("rejects ambiguous assignments, unsafe names, and empty selections", () => {
		for (const entries of [
			[entry("a"), entry("b")],
			[
				entry("a", { projectIds: ["x"] }),
				entry("b", { projectIds: ["x", "y"] }),
			],
			[entry("a", { projectIds: [] })],
			[entry("a", { name: "ZUSE_API_URL" })],
			[entry("a", { name: "NODE_OPTIONS" })],
			[entry("a", { name: "__proto__" })],
		]) {
			expect(() => validateEnvironmentBindings(entries)).toThrow();
		}
	});
});
describe("assignment conflicts", () => {
	const base = {
		name: "A",
		scope: "personal" as const,
		excludedProjectIds: [],
		target: "both" as const,
	};
	test("allows a project value to override a default, rejects ambiguity", () => {
		expect(
			environmentAssignmentConflict(
				{ ...base, projectIds: null },
				{ ...base, projectIds: ["p"] },
			),
		).toBeNull();
		expect(
			environmentAssignmentConflict(
				{ ...base, projectIds: ["p"] },
				{ ...base, projectIds: ["q"] },
			),
		).toBeNull();
		expect(
			environmentAssignmentConflict(
				{ ...base, projectIds: null },
				{ ...base, projectIds: null },
			),
		).toBe("duplicate_environment_default");
		expect(
			environmentAssignmentConflict(
				{ ...base, projectIds: ["p", "q"] },
				{ ...base, projectIds: ["q"] },
			),
		).toBe("overlapping_environment_projects");
	});
});
describe("dotenv parsing", () => {
	test("imports quotes, multiline, empty and duplicate values without execution or interpolation", () => {
		expect(
			parseEnvironmentFile(
				'# note\nexport A="one\\ntwo"\nB=\nA=second\nC=\'${A} $(echo hello)\'\nD="multi\nline"\n',
			),
		).toEqual([
			{ name: "A", value: "one\ntwo" },
			{ name: "B", value: "" },
			{ name: "A", value: "second" },
			{ name: "C", value: "${A} $(echo hello)" },
			{ name: "D", value: "multi\nline" },
		]);
	});
	test("keeps unquoted # that is not preceded by whitespace", () => {
		expect(
			parseEnvironmentFile(
				"URL=postgres://u:p#w@db/app # primary\nTOKEN=abc#def\nEMPTY=# note\n",
			),
		).toEqual([
			{ name: "URL", value: "postgres://u:p#w@db/app" },
			{ name: "TOKEN", value: "abc#def" },
			{ name: "EMPTY", value: "" },
		]);
	});
	test("can defer name validation to the caller", () => {
		expect(
			parseEnvironmentFile("ZUSE_TOKEN=x\nOK=y", { validateNames: false }),
		).toEqual([
			{ name: "ZUSE_TOKEN", value: "x" },
			{ name: "OK", value: "y" },
		]);
	});
	test.each([
		'A="unterminated',
		'A="value" unexpected',
		"invalid",
		"A B=x",
		"ZUSE_TOKEN=x",
	])("rejects malformed input: %s", (input) =>
		expect(() => parseEnvironmentFile(input)).toThrow());
});
describe("stream masking", () => {
	test("masks secrets at every possible chunk split", () => {
		const input = "before abcdef after abcdef!";
		for (let split = 0; split <= input.length; split++) {
			const masker = createSecretMasker(["abcdef"]);
			expect(
				masker.write(input.slice(0, split)) +
					masker.write(input.slice(split)) +
					masker.end(),
			).toBe("before [secret] after [secret]!");
		}
	});
	test("handles overlapping values, unicode, multiline, empty secrets, and flushes nonsecret prefixes", () => {
		const masker = createSecretMasker(["abc", "abcdef", "🙂\nkey", ""]);
		expect(
			masker.write("abc") +
				masker.write("def/🙂\n") +
				masker.write("key/ab") +
				masker.end(),
		).toBe("[secret]/[secret]/ab");
	});
});
