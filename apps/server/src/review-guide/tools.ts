/**
 * The tools a guide's writer calls, and the draft they fill in. Every call
 * is checked against the outline as it arrives and answers with what was
 * kept, what was not and why, and what is still unplaced, so the agent can
 * correct itself during the run instead of the server patching it after.
 *
 * @module review-guide/tools
 */
import type { AppToolResult, AppToolset } from "@zuse/agents/mcp-gateway";
import { ReviewGuideChapter, ReviewGuideOverview } from "@zuse/contracts";
import { z } from "zod";

import {
	type ChangeOutline,
	isReservedChapterId,
	OTHER_CHANGES_CHAPTER_ID,
	type OutlineHunkKind,
	resolveHandles,
} from "./outline.ts";

const MAX_CHAPTERS = 12;
const MAX_READ_HUNKS = 20;
const MAX_READ_BYTES = 60 * 1024;

const readHunksSchema = z.object({
	hunks: z
		.array(z.string())
		.min(1)
		.max(MAX_READ_HUNKS)
		.describe("Hunk handles like h12 (or f3 for a whole file)."),
});

const sketchLineSchema = z.object({
	kind: z
		.enum(["context", "add", "remove"])
		.describe("remove: what used to happen. add: what happens now."),
	indent: z.number().int().min(0).max(6).describe("Nesting depth."),
	code: z
		.string()
		.min(1)
		.max(120)
		.describe("Pseudo-code, not a copy of the diff."),
	note: z
		.string()
		.max(90)
		.optional()
		.describe("On changed lines: what the line means, a few words."),
	chapter: z
		.string()
		.optional()
		.describe("Id of the chapter that implements this line."),
});

const overviewSchema = z.object({
	title: z
		.string()
		.min(1)
		.max(80)
		.describe("A short title for the whole change, like a pull request title."),
	context: z
		.string()
		.min(1)
		.max(400)
		.describe("One or two sentences: what the change does and why."),
	steps: z
		.array(z.string().min(1).max(220))
		.min(1)
		.max(5)
		.describe("Two to five steps the change takes, in the order it works."),
	beforeAfter: z
		.object({
			caption: z
				.string()
				.min(1)
				.max(80)
				.describe(
					'What the sketch traces, e.g. "How a retry delay is chosen".',
				),
			lines: z.array(sketchLineSchema).min(2).max(14),
		})
		.optional(),
});

const chapterSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(40)
		.refine((id) => !isReservedChapterId(id), {
			message: "This id is reserved for chapters the guide adds itself.",
		})
		.describe("Short slug. Reusing an id revises that chapter."),
	title: z
		.string()
		.min(1)
		.max(80)
		.describe("What the chapter accomplishes, not a file name."),
	summary: z
		.string()
		.min(1)
		.max(900)
		.describe(
			"One or two short paragraphs, separated by a blank line: what changed here and why it matters. Wrap identifiers in backticks.",
		),
	hunks: z
		.array(z.string())
		.min(1)
		.describe("Handles of the core hunks this chapter owns."),
	validatedBy: z
		.array(z.string())
		.max(6)
		.optional()
		.describe("Handles of test hunks that exercise this chapter."),
	askHints: z
		.array(z.string().max(100))
		.max(2)
		.optional()
		.describe("Questions a reader might ask the author about this chapter."),
});

const finishSchema = z.object({
	force: z
		.boolean()
		.optional()
		.describe(
			"Finish even though hunks are unplaced; they become 'Other changes'.",
		),
});

export const GUIDE_TOOL_NAMES = [
	"guide_read_hunks",
	"guide_set_overview",
	"guide_add_chapter",
	"guide_finish",
] as const;

const definitions: AppToolset["definitions"] = [
	{
		name: "guide_read_hunks",
		description:
			"Read the code of up to 20 hunks from the change, by handle. Read a hunk before describing it.",
		inputSchema: z.toJSONSchema(readHunksSchema) as Record<string, unknown>,
		annotations: { readOnlyHint: true },
	},
	{
		name: "guide_set_overview",
		description:
			"Set the guide's overview: context, steps, and a before/after sketch. Call it after the chapters so the sketch can cite their ids; calling it again replaces it.",
		inputSchema: z.toJSONSchema(overviewSchema) as Record<string, unknown>,
		annotations: { readOnlyHint: true, idempotentHint: true },
	},
	{
		name: "guide_add_chapter",
		description:
			"Add the next chapter in reading order, or revise one by reusing its id. Each core hunk belongs to exactly one chapter.",
		inputSchema: z.toJSONSchema(chapterSchema) as Record<string, unknown>,
		annotations: { readOnlyHint: true, idempotentHint: true },
	},
	{
		name: "guide_finish",
		description:
			"Finish the guide once every core hunk is in a chapter. Refuses once while hunks are unplaced and lists them.",
		inputSchema: z.toJSONSchema(finishSchema) as Record<string, unknown>,
		annotations: { readOnlyHint: true },
	},
];

const CORE: ReadonlySet<OutlineHunkKind> = new Set(["core"]);
const TESTS: ReadonlySet<OutlineHunkKind> = new Set(["tests"]);
const ANY: ReadonlySet<OutlineHunkKind> = new Set([
	"core",
	"tests",
	"generated",
	"mechanical",
]);

const reply = (value: unknown, isError = false): AppToolResult => ({
	content: [{ type: "text", text: JSON.stringify(value) }],
	...(isError ? { isError: true } : {}),
});

/**
 * The guide being written. Chapters keep the order they were first added in;
 * a hunk belongs to the chapter that last claimed it only if no other chapter
 * holds it, so a chapter cannot silently steal another's hunk.
 */
export class GuideDraft {
	overview: ReviewGuideOverview | null;
	private readonly chapters = new Map<string, ReviewGuideChapter>();
	private readonly owner = new Map<string, string>();
	private refusedFinish = false;
	finished = false;
	/** Accepted overview and chapter writes the agent made in this run. */
	writes = 0;

	constructor(
		readonly outline: ChangeOutline,
		/** Chapters carried over from the previous guide, still accurate. */
		kept: ReadonlyArray<ReviewGuideChapter> = [],
		keptOverview: ReviewGuideOverview | null = null,
	) {
		this.overview = keptOverview;
		const live = new Set(outline.coreIds);
		for (const chapter of kept) {
			if (chapter.auto) continue;
			const hunkIds = chapter.hunkIds.filter((id) => live.has(id));
			if (hunkIds.length === 0) continue;
			this.chapters.set(
				chapter.id,
				new ReviewGuideChapter({
					...chapter,
					hunkIds,
					ordinal: this.chapters.size,
				}),
			);
			for (const id of hunkIds) this.owner.set(id, chapter.id);
		}
	}

	get chapterList(): ReadonlyArray<ReviewGuideChapter> {
		return [...this.chapters.values()];
	}

	get assigned(): number {
		return this.owner.size;
	}

	unplaced(): ReadonlyArray<string> {
		return this.outline.coreIds.filter((id) => !this.owner.has(id));
	}

	private handleOf(id: string): string {
		return this.outline.hunks.find((hunk) => hunk.id === id)?.handle ?? id;
	}

	private remaining() {
		const unplaced = this.unplaced();
		return {
			remainingUnplaced: unplaced.length,
			sample: unplaced.slice(0, 10).map((id) => {
				const hunk = this.outline.hunks.find((entry) => entry.id === id);
				return hunk === undefined
					? id
					: `${hunk.handle} ${hunk.path}${hunk.enclosing ? ` @ ${hunk.enclosing}` : ""}`;
			}),
		};
	}

	readHunks(input: unknown): AppToolResult {
		const parsed = readHunksSchema.safeParse(input);
		if (!parsed.success) return reply({ error: parsed.error.message }, true);
		const { ids, unknown } = resolveHandles(
			this.outline,
			parsed.data.hunks,
			ANY,
		);
		let bytes = 0;
		const hunks: Array<{ handle: string; path: string; patch: string }> = [];
		for (const id of ids) {
			const hunk = this.outline.hunks.find((entry) => entry.id === id);
			if (hunk === undefined) continue;
			if (bytes + hunk.text.length > MAX_READ_BYTES) break;
			bytes += hunk.text.length;
			hunks.push({ handle: hunk.handle, path: hunk.path, patch: hunk.text });
		}
		return reply({ hunks, unknown, truncated: hunks.length < ids.length });
	}

	setOverview(input: unknown): AppToolResult {
		const parsed = overviewSchema.safeParse(input);
		if (!parsed.success) return reply({ error: parsed.error.message }, true);
		const sketch = parsed.data.beforeAfter;
		this.overview = new ReviewGuideOverview({
			title: parsed.data.title.trim(),
			context: parsed.data.context.trim(),
			steps: parsed.data.steps.map((step) => step.trim()),
			beforeAfter:
				sketch === undefined
					? null
					: {
							caption: sketch.caption.trim(),
							lines: sketch.lines.map((line) => ({
								kind: line.kind,
								indent: line.indent,
								code: line.code,
								note: line.note?.trim() || null,
								chapterId: line.chapter?.trim() || null,
							})),
						},
		});
		this.writes += 1;
		return reply({ ok: true });
	}

	addChapter(input: unknown): AppToolResult {
		const parsed = chapterSchema.safeParse(input);
		if (!parsed.success) return reply({ error: parsed.error.message }, true);
		const data = parsed.data;
		const existing = this.chapters.get(data.id);
		if (existing === undefined && this.chapters.size >= MAX_CHAPTERS)
			return reply(
				{
					error: `A guide has at most ${MAX_CHAPTERS} chapters. Add these hunks to an existing chapter by reusing its id.`,
				},
				true,
			);
		const { ids, unknown } = resolveHandles(this.outline, data.hunks, CORE);
		const rejected: Array<{ hunk: string; reason: string }> = unknown.map(
			(handle) => ({
				hunk: handle,
				reason:
					"Not a core hunk of this change. Tests, generated, and mechanical hunks are grouped already.",
			}),
		);
		const accepted: string[] = [];
		for (const id of ids) {
			const owner = this.owner.get(id);
			if (owner !== undefined && owner !== data.id) {
				rejected.push({
					hunk: this.handleOf(id),
					reason: `Already in chapter "${owner}".`,
				});
				continue;
			}
			accepted.push(id);
		}
		if (accepted.length === 0 && existing === undefined)
			return reply({ error: "No hunks could be placed.", rejected }, true);
		const validatedBy = resolveHandles(
			this.outline,
			data.validatedBy ?? [],
			TESTS,
		).ids;
		const hunkIds = [...new Set([...(existing?.hunkIds ?? []), ...accepted])];
		this.chapters.set(
			data.id,
			new ReviewGuideChapter({
				id: data.id,
				ordinal: existing?.ordinal ?? this.chapters.size,
				kind: "core",
				title: data.title.trim(),
				summary: data.summary.trim(),
				hunkIds,
				validatedBy,
				askHints: (data.askHints ?? []).map((hint) => hint.trim()),
				auto: false,
			}),
		);
		for (const id of accepted) this.owner.set(id, data.id);
		this.writes += 1;
		return reply({
			accepted: accepted.map((id) => this.handleOf(id)),
			rejected,
			...this.remaining(),
		});
	}

	finish(input: unknown): AppToolResult {
		const parsed = finishSchema.safeParse(input ?? {});
		const force = parsed.success && parsed.data.force === true;
		const unplaced = this.unplaced();
		if (unplaced.length > 0 && !force && !this.refusedFinish) {
			this.refusedFinish = true;
			return reply(
				{
					error:
						"Some core hunks are not in any chapter. Add them to chapters, or call guide_finish again to group them as 'Other changes'.",
					...this.remaining(),
				},
				true,
			);
		}
		if (unplaced.length > 0) {
			this.chapters.set(
				OTHER_CHANGES_CHAPTER_ID,
				new ReviewGuideChapter({
					id: OTHER_CHANGES_CHAPTER_ID,
					ordinal: this.chapters.size,
					kind: "core",
					title: "Other changes",
					summary: "Changes the guide does not otherwise cover.",
					hunkIds: unplaced,
					validatedBy: [],
					askHints: [],
					auto: true,
				}),
			);
			for (const id of unplaced) this.owner.set(id, OTHER_CHANGES_CHAPTER_ID);
		}
		this.finished = true;
		return reply({ ok: true });
	}

	/** The gateway toolset; `onChange` runs after every accepted write. */
	toolset(onChange: () => void): AppToolset {
		return {
			definitions,
			call: async (name, args) => {
				if (this.finished && name !== "guide_read_hunks")
					return reply({ error: "The guide is finished." }, true);
				switch (name) {
					case "guide_read_hunks":
						return this.readHunks(args);
					case "guide_set_overview": {
						const result = this.setOverview(args);
						if (result.isError !== true) onChange();
						return result;
					}
					case "guide_add_chapter": {
						const result = this.addChapter(args);
						if (result.isError !== true) onChange();
						return result;
					}
					case "guide_finish": {
						const result = this.finish(args);
						if (result.isError !== true) onChange();
						return result;
					}
					default:
						return reply({ error: `Unknown tool: ${name}` }, true);
				}
			},
		};
	}
}
