import { describe, expect, it } from "vitest";
import {
	workflowMetadata,
	workflowProgress,
	workflowSections,
} from "../../src/lib/workflow-display.ts";

describe("workflow metadata", () => {
	it("reads a literal plan without executing the workflow", () => {
		expect(
			workflowMetadata(`export const meta = {
			name: 'release-check', description: 'Validate a release',
			phases: [{ title: 'Map', detail: 'Inspect changes' }, { title: 'Build' }],
		}; await phase('Map', async () => { throw new Error('must not run'); });`),
		).toEqual({
			name: "release-check",
			description: "Validate a release",
			phases: [
				{ title: "Map", detail: "Inspect changes" },
				{ title: "Build", detail: null },
			],
		});
	});
	it("handles comments, escaped strings, and quoted keys", () => {
		expect(
			workflowMetadata(
				`// plan\nexport const meta = { "name": "team's plan", /* details */ phases: [{ title: 'Read \\'docs\\'' }] };`,
			)?.phases[0]?.title,
		).toBe("Read 'docs'");
	});
	it("ignores computed metadata, accessors, and spreads", () => {
		expect(
			workflowMetadata(
				`export const meta = { get name() { throw 1; }, description: dangerous(), ...other, phases: [{ title: dynamic }, { title: 'Safe' }] };`,
			),
		).toEqual({
			name: null,
			description: null,
			phases: [{ title: "Safe", detail: null }],
		});
	});
	it("falls back for named runs, partial scripts, and excessive input", () => {
		for (const script of [
			"",
			"export const meta = {",
			"const meta = {}",
			" ".repeat(200_001),
		])
			expect(workflowMetadata(script)).toBeNull();
	});
});

describe("workflow sections", () => {
	const progress = workflowProgress({
		script: "",
		workflow_progress: {
			phases: [
				{ index: 1, title: "Map" },
				{ index: 2, title: "Review" },
			],
			agents: [
				{
					index: 1,
					label: "map:a",
					phaseIndex: 1,
					phaseTitle: "Map",
					state: "done",
					startedAt: 10,
					durationMs: 5,
					promptPreview: "Read a",
					resultPreview: "A is fine",
				},
				{
					index: 2,
					label: "map:b",
					phaseIndex: 1,
					state: "running",
					startedAt: 12,
					durationMs: 8,
					promptPreview: "Read b",
				},
				{ index: 3, label: "setup", state: "queued" },
				{
					index: 4,
					label: "check:a",
					phaseTitle: "Review",
					state: "failed",
					error: "Timed out",
				},
			],
		},
	});

	it("rejects snapshots that do not match the contract", () => {
		expect(
			workflowProgress({ workflow_progress: { agents: "nope" } }),
		).toBeNull();
		expect(workflowProgress({ script: "" })).toBeNull();
	});

	it("groups agents under declared phases in script order", () => {
		const sections = workflowSections(
			[
				{ title: "Review", detail: "Check findings" },
				{ title: "Map", detail: null },
				{ title: "Ship", detail: "Not started" },
			],
			progress,
			"working",
		);
		expect(
			sections.map((section) => [
				section.title,
				section.agents.map((agent) => [agent.label, agent.status]),
				section.done,
			]),
		).toEqual([
			[null, [["setup", "queued"]], 0],
			["Review", [["check:a", "failed"]], 0],
			[
				"Map",
				[
					["a", "done"],
					["b", "working"],
				],
				1,
			],
			["Ship", [], 0],
		]);
		expect(sections[2]?.agents[0]).toMatchObject({
			preview: "A is fine",
			prompt: "Read a",
			startedAt: 10,
			completedAt: 15,
		});
		expect(sections[2]?.agents[1]).toMatchObject({
			status: "working",
			startedAt: 12,
			completedAt: null,
		});
		expect(sections[1]?.agents[0]?.preview).toBe("Timed out");
		expect(sections[3]?.detail).toBe("Not started");
	});

	it("settles agents the final snapshot left active", () => {
		const statuses = (run: "done" | "stopped") =>
			workflowSections([], progress, run)
				.flatMap((section) => section.agents)
				.map((agent) => agent.status);
		expect(statuses("done")).toEqual(["done", "done", "done", "failed"]);
		expect(statuses("stopped")).toEqual([
			"stopped",
			"done",
			"stopped",
			"failed",
		]);
	});
});
