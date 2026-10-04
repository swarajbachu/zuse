import type { EnvironmentEntry } from "@zuse/contracts";
import {
	environmentAssignmentConflict,
	parseEnvironmentFile,
	validateEnvironmentName,
} from "@zuse/utils/environment";
import { blankEnvironmentEntry } from "./environment-vault.ts";

/** One editable row in the bulk add sheet. `projectIds: null` means all projects. */
export type EnvironmentDraft = {
	readonly key: string;
	readonly name: string;
	readonly value: string;
	readonly projectIds: readonly string[] | null;
};

export const MAX_ENVIRONMENT_DRAFTS = 500;

export const emptyEnvironmentDraft = (): EnvironmentDraft => ({
	key: crypto.randomUUID(),
	name: "",
	value: "",
	projectIds: null,
});

export const environmentNameProblem = (name: string): string | null => {
	if (name.length === 0) return null;
	try {
		validateEnvironmentName(name);
		return null;
	} catch (cause) {
		return cause instanceof Error &&
			cause.message === "reserved_environment_name"
			? "This name is reserved by Zuse or the runtime."
			: "Use letters, digits, and underscores. Start with a letter or underscore.";
	}
};

const ASSIGNMENT_LINE =
	/^[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*[ \t]*=/m;

const LOOSE_ASSIGNMENT = /^[ \t]*(?:export[ \t]+)?([^\s=#][^=]*?)[ \t]*=(.*)$/;

/**
 * Line-by-line fallback for text the strict parser rejects, so one malformed
 * line becomes a flagged row instead of discarding the whole paste.
 */
const parseEnvironmentLines = (
	text: string,
): Array<{ name: string; value: string }> =>
	text.split(/\r?\n/).flatMap((line) => {
		const match = LOOSE_ASSIGNMENT.exec(line);
		if (!match) return [];
		const name = match[1] ?? "";
		const raw = match[2] ?? "";
		try {
			const [strict] = parseEnvironmentFile(`X=${raw}`, {
				validateNames: false,
			});
			return [{ name, value: strict?.value ?? "" }];
		} catch {
			return [{ name, value: raw.trim() }];
		}
	});

/**
 * Reads pasted dotenv text. Returns null when the text should paste as plain
 * input: no `NAME=` line, or a single assignment pasted into a value (values
 * may legitimately contain `=`).
 */
export const parsePastedEnvironment = (
	text: string,
	field: "name" | "value",
): ReadonlyArray<{ name: string; value: string }> | null => {
	if (!ASSIGNMENT_LINE.test(text)) return null;
	let parsed: ReadonlyArray<{ name: string; value: string }>;
	try {
		parsed = parseEnvironmentFile(text, { validateNames: false });
	} catch {
		parsed = parseEnvironmentLines(text);
	}
	if (parsed.length === 0) return null;
	if (field === "value" && parsed.length < 2) return null;
	return parsed;
};

/**
 * Inserts pasted variables at `index`. An empty target row is replaced, a
 * repeated name keeps its last value (dotenv semantics), and rows already in
 * the dialog with the same name are updated in place.
 */
export const mergePastedDrafts = (
	drafts: ReadonlyArray<EnvironmentDraft>,
	index: number,
	pasted: ReadonlyArray<{ name: string; value: string }>,
): EnvironmentDraft[] => {
	const latest = new Map<string, string>();
	for (const item of pasted) latest.set(item.name, item.value);
	const target = drafts[index];
	const replaceTarget =
		target !== undefined &&
		(latest.has(target.name) ||
			(target.name.length === 0 && target.value.length === 0));
	const next: EnvironmentDraft[] = [];
	const inserted: EnvironmentDraft[] = [];
	for (const [name, value] of latest) {
		const existing = drafts.find(
			(draft, at) => draft.name === name && !(replaceTarget && at === index),
		);
		if (existing) continue;
		inserted.push({
			key: crypto.randomUUID(),
			name,
			value,
			projectIds: replaceTarget && target ? target.projectIds : null,
		});
	}
	drafts.forEach((draft, at) => {
		if (at === index && replaceTarget) {
			next.push(...inserted);
			return;
		}
		const value = latest.get(draft.name);
		next.push(value === undefined ? draft : { ...draft, value });
		if (at === index) next.push(...inserted);
	});
	if (index >= drafts.length) next.push(...inserted);
	return next.slice(0, MAX_ENVIRONMENT_DRAFTS);
};

/** An existing entry with the same name and exactly this assignment is updated, not duplicated. */
export const matchingEnvironmentEntry = (
	entries: ReadonlyArray<EnvironmentEntry>,
	name: string,
	assignment: Pick<EnvironmentEntry, "projectIds">,
): EnvironmentEntry | undefined =>
	entries.find(
		(entry) =>
			entry.name === name &&
			entry.scope === "personal" &&
			entry.target === "both" &&
			(entry.projectIds === null
				? assignment.projectIds === null
				: assignment.projectIds !== null &&
					entry.projectIds.length === assignment.projectIds.length &&
					entry.projectIds.every((id) => assignment.projectIds?.includes(id))),
	);

export const draftToEntry = (
	draft: EnvironmentDraft,
	kind: EnvironmentEntry["kind"],
	entries: ReadonlyArray<EnvironmentEntry>,
): EnvironmentEntry => {
	const projectIds =
		draft.projectIds !== null && draft.projectIds.length > 0
			? draft.projectIds
			: null;
	const existing = matchingEnvironmentEntry(entries, draft.name, {
		projectIds,
	});
	// Updating keeps the stored entry's exclusions; only the value and kind change.
	return existing
		? { ...existing, kind }
		: blankEnvironmentEntry({ name: draft.name, kind, projectIds });
};

/** The projects every draft shares, `undefined` when they differ. */
export const commonDraftProjects = (
	drafts: ReadonlyArray<EnvironmentDraft>,
): readonly string[] | null | undefined => {
	const [first, ...rest] = drafts;
	if (!first) return undefined;
	const key = (ids: readonly string[] | null) =>
		ids === null ? "*" : [...ids].sort().join("\n");
	const expected = key(first.projectIds);
	return rest.every((draft) => key(draft.projectIds) === expected)
		? first.projectIds
		: undefined;
};

export type EnvironmentDraftStatus =
	| { readonly kind: "empty" }
	| { readonly kind: "invalid"; readonly message: string }
	| { readonly kind: "new" }
	| { readonly kind: "update" };

/** Validates every row against its siblings and the stored entries. */
export const environmentDraftStatuses = (
	drafts: ReadonlyArray<EnvironmentDraft>,
	entries: ReadonlyArray<EnvironmentEntry>,
): EnvironmentDraftStatus[] => {
	const candidates = drafts.map((draft) => ({
		draft,
		entry: draftToEntry(draft, "secret", entries),
	}));
	return candidates.map(({ draft, entry }, index) => {
		if (draft.name.length === 0 && draft.value.length === 0)
			return { kind: "empty" };
		if (draft.name.length === 0)
			return { kind: "invalid", message: "Add a name." };
		const problem = environmentNameProblem(draft.name);
		if (problem) return { kind: "invalid", message: problem };
		const sibling = candidates.findIndex(
			(other, at) =>
				at !== index &&
				other.draft.name.length > 0 &&
				environmentAssignmentConflict(entry, other.entry) !== null,
		);
		if (sibling !== -1)
			return {
				kind: "invalid",
				message: "Duplicate name for the same projects.",
			};
		const stored = entries.find(
			(other) =>
				other.id !== entry.id &&
				environmentAssignmentConflict(entry, other) !== null,
		);
		if (stored)
			return {
				kind: "invalid",
				message: "Already set for some of these projects.",
			};
		return { kind: entry.id ? "update" : "new" };
	});
};
