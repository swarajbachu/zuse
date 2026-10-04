import type { EnvironmentEntry } from "@zuse/contracts";
import { describe, expect, test } from "vitest";
import {
	commonDraftProjects,
	draftToEntry,
	type EnvironmentDraft,
	environmentDraftStatuses,
	mergePastedDrafts,
	parsePastedEnvironment,
} from "../../src/components/settings/environment-drafts.ts";

const draft = (
	name: string,
	value = "",
	projectIds: readonly string[] | null = null,
): EnvironmentDraft => ({
	key: name || crypto.randomUUID(),
	name,
	value,
	projectIds,
});

const stored = (overrides: Partial<EnvironmentEntry>): EnvironmentEntry => ({
	id: "e1",
	name: "A",
	kind: "secret",
	scope: "personal",
	projectIds: null,
	excludedProjectIds: [],
	target: "both",
	revision: 1,
	updatedAt: 0,
	...overrides,
});

describe("pasted environment text", () => {
	test("splits a pasted .env file into variables", () => {
		expect(
			parsePastedEnvironment(
				'# app\nexport API_URL=https://x.test\nSECRET="a b"\n\nTOKEN=abc#def\n',
				"name",
			),
		).toEqual([
			{ name: "API_URL", value: "https://x.test" },
			{ name: "SECRET", value: "a b" },
			{ name: "TOKEN", value: "abc#def" },
		]);
	});

	test("leaves ordinary text and single assignments in values alone", () => {
		expect(parsePastedEnvironment("DATABASE_URL", "name")).toBeNull();
		expect(parsePastedEnvironment("a=b", "value")).toBeNull();
		expect(parsePastedEnvironment("A=1", "name")).toEqual([
			{ name: "A", value: "1" },
		]);
		expect(parsePastedEnvironment("A=1\nB=2", "value")).toHaveLength(2);
	});

	test("turns malformed lines into rows instead of dropping the paste", () => {
		expect(
			parsePastedEnvironment(
				'GOOD=1\nbad-name=two\n# note\nQUOTED="x y"\nnot an assignment',
				"name",
			),
		).toEqual([
			{ name: "GOOD", value: "1" },
			{ name: "bad-name", value: "two" },
			{ name: "QUOTED", value: "x y" },
		]);
	});

	test("keeps reserved names so the row can explain the problem", () => {
		expect(parsePastedEnvironment("ZUSE_X=1\nB=2", "name")).toEqual([
			{ name: "ZUSE_X", value: "1" },
			{ name: "B", value: "2" },
		]);
	});
});

describe("merging pasted rows", () => {
	test("replaces the empty row it was pasted into, last duplicate wins", () => {
		const result = mergePastedDrafts([draft("")], 0, [
			{ name: "A", value: "1" },
			{ name: "B", value: "2" },
			{ name: "A", value: "3" },
		]);
		expect(result.map(({ name, value }) => [name, value])).toEqual([
			["A", "3"],
			["B", "2"],
		]);
	});

	test("updates existing rows and inserts the rest after the target", () => {
		const result = mergePastedDrafts(
			[draft("KEEP", "k"), draft("B", "old"), draft("")],
			0,
			[
				{ name: "B", value: "new" },
				{ name: "C", value: "c" },
			],
		);
		expect(result.map(({ name, value }) => [name, value])).toEqual([
			["KEEP", "k"],
			["C", "c"],
			["B", "new"],
			["", ""],
		]);
	});

	test("carries the target row's projects to the pasted rows", () => {
		const result = mergePastedDrafts([draft("", "", ["p1"])], 0, [
			{ name: "A", value: "1" },
		]);
		expect(result[0]?.projectIds).toEqual(["p1"]);
	});
});

describe("draft validation", () => {
	test("rows default to all projects and can pick their own", () => {
		expect(draftToEntry(draft("A", "1"), "secret", []).projectIds).toBeNull();
		expect(
			draftToEntry(draft("A", "1", ["p2"]), "secret", []).projectIds,
		).toEqual(["p2"]);
	});

	test("updates a stored entry with the same name and assignment, keeping exclusions", () => {
		const existing = stored({ excludedProjectIds: ["p9"] });
		expect(draftToEntry(draft("A", "1"), "variable", [existing])).toMatchObject(
			{
				id: "e1",
				kind: "variable",
				excludedProjectIds: ["p9"],
			},
		);
		expect(environmentDraftStatuses([draft("A", "1")], [existing])).toEqual([
			{ kind: "update" },
		]);
	});

	test("allows the same name for different projects and flags overlaps", () => {
		expect(
			environmentDraftStatuses(
				[draft("A", "1", ["p1"]), draft("A", "2", ["p2"])],
				[],
			).map((status) => status.kind),
		).toEqual(["new", "new"]);
		expect(
			environmentDraftStatuses(
				[draft("A", "1", ["p1"]), draft("A", "2", ["p1", "p2"])],
				[],
			).map((status) => status.kind),
		).toEqual(["invalid", "invalid"]);
	});

	test("reports names and stored conflicts", () => {
		expect(
			environmentDraftStatuses(
				[draft(""), draft("", "v"), draft("bad-name", "v"), draft("A", "v")],
				[],
			).map((status) => status.kind),
		).toEqual(["empty", "invalid", "invalid", "new"]);
		expect(
			environmentDraftStatuses(
				[draft("A", "v", ["p1"])],
				[stored({ projectIds: ["p1", "p2"] })],
			),
		).toEqual([
			{ kind: "invalid", message: "Already set for some of these projects." },
		]);
	});

	test("summarizes the projects rows share", () => {
		expect(commonDraftProjects([draft("A"), draft("B")])).toBeNull();
		expect(
			commonDraftProjects([
				draft("A", "", ["p1", "p2"]),
				draft("B", "", ["p2", "p1"]),
			]),
		).toEqual(["p1", "p2"]);
		expect(
			commonDraftProjects([draft("A"), draft("B", "", ["p1"])]),
		).toBeUndefined();
	});
});
