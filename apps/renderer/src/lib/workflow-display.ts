import {
	WORKFLOW_PROGRESS_KEY,
	type WorkflowAgentProgress,
	WorkflowProgress,
} from "@zuse/contracts";
import { type Expression, type ObjectExpression, parse } from "acorn";
import { Option, Schema } from "effect";
import type { DelegationStatus } from "./delegation-display.ts";

export interface WorkflowMetadata {
	readonly name: string | null;
	readonly description: string | null;
	readonly phases: ReadonlyArray<{
		readonly title: string;
		readonly detail: string | null;
	}>;
}

const property = (
	object: ObjectExpression,
	name: string,
): Expression | null => {
	for (const entry of object.properties) {
		if (
			entry.type !== "Property" ||
			entry.computed ||
			entry.kind !== "init" ||
			entry.method
		)
			continue;
		const key =
			entry.key.type === "Identifier"
				? entry.key.name
				: entry.key.type === "Literal"
					? entry.key.value
					: null;
		if (key === name) return entry.value;
	}
	return null;
};
const literal = (value: Expression | null): string | null =>
	value?.type === "Literal" && typeof value.value === "string"
		? value.value
		: null;

/** Read declared metadata without evaluating any part of an agent-authored script. */
export function workflowMetadata(script: string): WorkflowMetadata | null {
	if (script.length > 200_000) return null;
	try {
		const program = parse(script, {
			ecmaVersion: "latest",
			sourceType: "module",
			allowAwaitOutsideFunction: true,
		});
		const first = program.body[0];
		if (
			first?.type !== "ExportNamedDeclaration" ||
			first.declaration?.type !== "VariableDeclaration"
		)
			return null;
		const declaration = first.declaration.declarations.find(
			(entry) => entry.id.type === "Identifier" && entry.id.name === "meta",
		);
		if (declaration?.init?.type !== "ObjectExpression") return null;
		const meta = declaration.init;
		const phases = property(meta, "phases");
		return {
			name: literal(property(meta, "name")),
			description: literal(property(meta, "description")),
			phases:
				phases?.type === "ArrayExpression"
					? phases.elements.flatMap((entry) => {
							if (entry?.type !== "ObjectExpression") return [];
							const title = literal(property(entry, "title"));
							return title === null
								? []
								: [{ title, detail: literal(property(entry, "detail")) }];
						})
					: [],
		};
	} catch {
		return null;
	}
}

export function workflowInput(input: unknown): Record<string, unknown> {
	return input !== null && typeof input === "object"
		? (input as Record<string, unknown>)
		: {};
}

const decodeProgress = Schema.decodeUnknownOption(WorkflowProgress);

/** The latest phase and agent snapshot the driver attached to a run. */
export function workflowProgress(input: unknown): WorkflowProgress | null {
	const value = workflowInput(input)[WORKFLOW_PROGRESS_KEY];
	return value === undefined ? null : Option.getOrNull(decodeProgress(value));
}

export type WorkflowAgentStatus = DelegationStatus | "queued";

export interface WorkflowAgentView {
	readonly index: number;
	readonly label: string;
	readonly status: WorkflowAgentStatus;
	readonly preview: string | null;
	readonly prompt: string | null;
	readonly result: string | null;
	readonly startedAt: number | null;
	readonly completedAt: number | null;
}

export interface WorkflowSection {
	readonly key: string;
	/** Null for agents started outside any phase. */
	readonly title: string | null;
	readonly detail: string | null;
	readonly agents: ReadonlyArray<WorkflowAgentView>;
	readonly done: number;
}

/**
 * An agent the snapshot still shows as active cannot outlive its run: once
 * the workflow settles, it inherits the run's outcome.
 */
const agentStatus = (
	agent: WorkflowAgentProgress,
	run: DelegationStatus,
): WorkflowAgentStatus => {
	if (agent.state === "done") return "done";
	if (agent.state === "failed") return "failed";
	if (run === "working") return agent.state === "queued" ? "queued" : "working";
	return run === "done" ? "done" : "stopped";
};

/** "map:catalog" under "Map" reads as "catalog"; the phase already says Map. */
const labelWithinPhase = (label: string, phase: string | undefined): string => {
	const separator = label.indexOf(":");
	if (phase === undefined || separator <= 0) return label;
	const rest = label.slice(separator + 1).trim();
	return rest.length > 0 &&
		label.slice(0, separator).trim().toLowerCase() === phase.toLowerCase()
		? rest
		: label;
};

const agentView = (
	agent: WorkflowAgentProgress,
	run: DelegationStatus,
	phase: string | undefined,
): WorkflowAgentView => {
	const status = agentStatus(agent, run);
	const startedAt = agent.startedAt ?? null;
	const result = agent.error ?? agent.resultPreview ?? null;
	return {
		index: agent.index,
		label: labelWithinPhase(agent.label, phase),
		status,
		preview: result ?? agent.promptPreview ?? null,
		prompt: agent.promptPreview ?? null,
		result,
		startedAt,
		completedAt:
			status !== "working" &&
			status !== "queued" &&
			startedAt !== null &&
			agent.durationMs !== undefined
				? startedAt + agent.durationMs
				: null,
	};
};

/**
 * Group a run's agents under its phases: declared phases keep their script
 * order and detail, phases first seen at runtime follow in start order, and
 * agents outside any phase lead.
 */
export function workflowSections(
	declared: WorkflowMetadata["phases"],
	progress: WorkflowProgress | null,
	run: DelegationStatus,
): ReadonlyArray<WorkflowSection> {
	type Section = {
		key: string;
		title: string | null;
		detail: string | null;
		agents: WorkflowAgentView[];
	};
	const sections: Section[] = declared.map((phase, index) => ({
		key: `declared:${index}`,
		title: phase.title,
		detail: phase.detail,
		agents: [],
	}));
	const byIndex = new Map<number, Section>();
	const matched = new Set<Section>();
	const phase = (index: number, title: string): Section => {
		const existing = byIndex.get(index);
		if (existing !== undefined) return existing;
		let section = sections.find(
			(candidate) => candidate.title === title && !matched.has(candidate),
		);
		if (section === undefined) {
			section = { key: `runtime:${index}`, title, detail: null, agents: [] };
			sections.push(section);
		}
		matched.add(section);
		byIndex.set(index, section);
		return section;
	};
	for (const entry of progress?.phases ?? []) phase(entry.index, entry.title);
	const unphased: Section = {
		key: "unphased",
		title: null,
		detail: null,
		agents: [],
	};
	for (const agent of progress?.agents ?? []) {
		let section =
			agent.phaseIndex === undefined
				? undefined
				: byIndex.get(agent.phaseIndex);
		if (
			section === undefined &&
			agent.phaseIndex !== undefined &&
			agent.phaseTitle !== undefined
		) {
			section = phase(agent.phaseIndex, agent.phaseTitle);
		}
		if (
			section === undefined &&
			agent.phaseIndex === undefined &&
			agent.phaseTitle !== undefined
		) {
			// A title-only snapshot cannot identify which repeated occurrence it means.
			const candidates = sections.filter(
				(candidate) => candidate.title === agent.phaseTitle,
			);
			if (candidates.length === 1) section = candidates[0];
			else if (candidates.length === 0) {
				section = {
					key: `title:${agent.phaseTitle}`,
					title: agent.phaseTitle,
					detail: null,
					agents: [],
				};
				sections.push(section);
			}
		}
		const target = section ?? unphased;
		target.agents.push(agentView(agent, run, target.title ?? undefined));
	}
	return (unphased.agents.length > 0 ? [unphased, ...sections] : sections).map(
		(section) => ({
			...section,
			done: section.agents.filter((agent) => agent.status === "done").length,
		}),
	);
}
