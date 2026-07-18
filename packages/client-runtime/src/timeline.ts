import type { Message } from "@zuse/contracts";

export type TimelineTurn = {
	readonly id: string;
	readonly user: Message | null;
	readonly body: readonly Message[];
	readonly startedAt: Date;
	readonly endedAt: Date;
	readonly durationMs: number;
};

export type DiffLineKind = "context" | "added" | "removed" | "hunk";

export type DiffLine = {
	readonly kind: DiffLineKind;
	readonly text: string;
	readonly oldLine: number | null;
	readonly newLine: number | null;
};

export type FileChange = {
	readonly path: string;
	readonly added: number;
	readonly removed: number;
	readonly lines: readonly DiffLine[];
};

export type TurnActivitySummary = {
	readonly tools: number;
	readonly commands: number;
	readonly reads: number;
	readonly searches: number;
	readonly agents: number;
	readonly files: readonly FileChange[];
	readonly added: number;
	readonly removed: number;
};

export const isUserMessage = (message: Message): boolean =>
	message.content._tag === "user" || message.content._tag === "user_rich";

const toolUseKey = (message: Message): string | null =>
	message.content._tag === "tool_use"
		? `${message.sessionId}:${message.content.itemId}`
		: null;

const inputScore = (input: unknown): number => {
	if (input === null || input === undefined) return 0;
	let score = 1;
	if (typeof input === "object") {
		const value = input as Record<string, unknown>;
		for (const key of ["file_path", "command", "old_string", "new_string"]) {
			if (typeof value[key] === "string") score += 4;
		}
	}
	try {
		return score + (JSON.stringify(input)?.length ?? 0);
	} catch {
		return score + String(input).length;
	}
};

export const normalizeTimelineMessages = (
	messages: readonly Message[],
): Message[] => {
	const normalized: Message[] = [];
	const indexByTool = new Map<string, number>();
	for (const message of messages) {
		const key = toolUseKey(message);
		if (key === null) {
			normalized.push(message);
			continue;
		}
		const index = indexByTool.get(key);
		if (index === undefined) {
			indexByTool.set(key, normalized.length);
			normalized.push(message);
			continue;
		}
		const current = normalized[index];
		if (
			current?.content._tag === "tool_use" &&
			message.content._tag === "tool_use" &&
			inputScore(message.content.input) > inputScore(current.content.input)
		) {
			normalized[index] = message;
		}
	}
	return normalized;
};

export const groupTimelineTurns = (
	messages: readonly Message[],
): TimelineTurn[] => {
	const turns: Array<{ user: Message | null; body: Message[] }> = [];
	let current: { user: Message | null; body: Message[] } | null = null;
	for (const message of normalizeTimelineMessages(messages)) {
		if (isUserMessage(message)) {
			if (current !== null) turns.push(current);
			current = { user: message, body: [] };
		} else {
			current ??= { user: null, body: [] };
			current.body.push(message);
		}
	}
	if (current !== null) turns.push(current);

	return turns.map((turn, index) => {
		const all = turn.user === null ? turn.body : [turn.user, ...turn.body];
		const first = all[0]?.createdAt ?? new Date(0);
		const last = all[all.length - 1]?.createdAt ?? first;
		return {
			id: String(turn.user?.id ?? all[0]?.id ?? `turn-${index}`),
			user: turn.user,
			body: turn.body,
			startedAt: first,
			endedAt: last,
			durationMs: Math.max(0, last.getTime() - first.getTime()),
		};
	});
};

const recordOf = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;

const stringOf = (value: unknown): string | null =>
	typeof value === "string" ? value : null;

const linesForReplacement = (oldText: string, newText: string): DiffLine[] => [
	...oldText.split(/\r\n|\r|\n/).map((text, index) => ({
		kind: "removed" as const,
		text,
		oldLine: index + 1,
		newLine: null,
	})),
	...newText.split(/\r\n|\r|\n/).map((text, index) => ({
		kind: "added" as const,
		text,
		oldLine: null,
		newLine: index + 1,
	})),
];

export const parseUnifiedPatch = (patch: string): DiffLine[] => {
	const lines: DiffLine[] = [];
	let oldLine = 0;
	let newLine = 0;
	for (const raw of patch.split(/\r\n|\r|\n/)) {
		const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
		if (header !== null) {
			oldLine = Number(header[1]);
			newLine = Number(header[2]);
			lines.push({ kind: "hunk", text: raw, oldLine: null, newLine: null });
		} else if (raw.startsWith("+") && !raw.startsWith("+++")) {
			lines.push({ kind: "added", text: raw.slice(1), oldLine: null, newLine });
			newLine += 1;
		} else if (raw.startsWith("-") && !raw.startsWith("---")) {
			lines.push({
				kind: "removed",
				text: raw.slice(1),
				oldLine,
				newLine: null,
			});
			oldLine += 1;
		} else if (!raw.startsWith("\\")) {
			const text = raw.startsWith(" ") ? raw.slice(1) : raw;
			lines.push({ kind: "context", text, oldLine, newLine });
			oldLine += 1;
			newLine += 1;
		}
	}
	return lines;
};

const makeChange = (path: string, lines: readonly DiffLine[]): FileChange => ({
	path,
	added: lines.filter((line) => line.kind === "added").length,
	removed: lines.filter((line) => line.kind === "removed").length,
	lines,
});

const applyPatchTextOf = (value: unknown): string | null => {
	const direct = stringOf(value);
	if (direct !== null) return direct;
	const record = recordOf(value);
	return stringOf(record?.patch) ?? stringOf(record?.apply_patch);
};

const parseApplyPatchChanges = (patch: string): FileChange[] => {
	if (!patch.trimStart().startsWith("*** Begin Patch")) return [];
	const byPath = new Map<string, DiffLine[]>();
	let path: string | null = null;
	let lines: DiffLine[] = [];
	let oldLine = 1;
	let newLine = 1;
	const finish = () => {
		if (path === null) return;
		const existing = byPath.get(path);
		byPath.set(path, existing === undefined ? lines : [...existing, ...lines]);
	};

	for (const raw of patch.split(/\r\n|\r|\n/)) {
		const header = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(raw);
		if (header !== null) {
			finish();
			path = header[1]?.trim() ?? null;
			lines = [];
			oldLine = 1;
			newLine = 1;
			continue;
		}
		const move = /^\*\*\* Move to: (.+)$/.exec(raw);
		if (move !== null && path !== null) {
			path = move[1]?.trim() ?? path;
			continue;
		}
		if (path === null || raw === "*** End Patch") continue;
		if (raw.startsWith("@@")) {
			lines.push({ kind: "hunk", text: raw, oldLine: null, newLine: null });
			continue;
		}
		if (raw.startsWith("+")) {
			lines.push({
				kind: "added",
				text: raw.slice(1),
				oldLine: null,
				newLine,
			});
			newLine += 1;
			continue;
		}
		if (raw.startsWith("-")) {
			lines.push({
				kind: "removed",
				text: raw.slice(1),
				oldLine,
				newLine: null,
			});
			oldLine += 1;
			continue;
		}
		if (raw.startsWith(" ")) {
			lines.push({
				kind: "context",
				text: raw.slice(1),
				oldLine,
				newLine,
			});
			oldLine += 1;
			newLine += 1;
		}
	}
	finish();
	return [...byPath].map(([filePath, fileLines]) =>
		makeChange(filePath, fileLines),
	);
};

export const extractFileChanges = (
	tool: string,
	input: unknown,
): FileChange[] => {
	const value = recordOf(input);
	if (value === null) return [];
	const path = stringOf(value.file_path) ?? stringOf(value.path);

	const patches = Array.isArray(value.patches) ? value.patches : null;
	if (patches !== null) {
		return patches.flatMap((entry) => {
			const patch = recordOf(entry);
			const patchPath = stringOf(patch?.file_path) ?? stringOf(patch?.path);
			const text = stringOf(patch?.patch) ?? stringOf(patch?.unified_diff);
			return patchPath !== null && text !== null
				? [makeChange(patchPath, parseUnifiedPatch(text))]
				: [];
		});
	}

	const unified =
		applyPatchTextOf(value.patch) ??
		stringOf(value.apply_patch) ??
		stringOf(value.unified_diff);
	if (unified !== null) {
		const applyPatchChanges = parseApplyPatchChanges(unified);
		if (applyPatchChanges.length > 0) return applyPatchChanges;
	}
	if (path !== null && unified !== null) {
		return [makeChange(path, parseUnifiedPatch(unified))];
	}
	if (path === null) return [];

	if (tool === "Write" || tool === "WriteFile") {
		const content = stringOf(value.content);
		return content === null
			? []
			: [makeChange(path, linesForReplacement("", content))];
	}
	if (tool === "MultiEdit" && Array.isArray(value.edits)) {
		const lines = value.edits.flatMap((entry) => {
			const edit = recordOf(entry);
			const before = stringOf(edit?.old_string);
			const after = stringOf(edit?.new_string);
			return before !== null && after !== null
				? linesForReplacement(before, after)
				: [];
		});
		return lines.length === 0 ? [] : [makeChange(path, lines)];
	}
	const before = stringOf(value.old_string);
	const after = stringOf(value.new_string);
	return before !== null && after !== null
		? [makeChange(path, linesForReplacement(before, after))]
		: [];
};

const normalizeTool = (tool: string): string => tool.toLowerCase();

export const summarizeTurnActivity = (
	body: readonly Message[],
): TurnActivitySummary => {
	let tools = 0;
	let commands = 0;
	let reads = 0;
	let searches = 0;
	let agents = 0;
	const files: FileChange[] = [];
	for (const message of body) {
		if (message.content._tag === "subagent_summary") agents += 1;
		if (message.content._tag !== "tool_use") continue;
		tools += 1;
		const tool = normalizeTool(message.content.tool);
		if (/bash|shell|execute|command|terminal/.test(tool)) commands += 1;
		if (/^read|readfile/.test(tool)) reads += 1;
		if (/grep|glob|search/.test(tool)) searches += 1;
		if (/task|agent|spawn/.test(tool)) agents += 1;
		files.push(
			...extractFileChanges(message.content.tool, message.content.input),
		);
	}
	return {
		tools,
		commands,
		reads,
		searches,
		agents,
		files,
		added: files.reduce((total, file) => total + file.added, 0),
		removed: files.reduce((total, file) => total + file.removed, 0),
	};
};
