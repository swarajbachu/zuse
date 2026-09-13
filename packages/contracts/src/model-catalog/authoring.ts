import type {
	BooleanOptionDescriptor,
	ModelOption,
	ReasoningLevel,
	SelectOptionDescriptor,
} from "../agent.ts";

/**
 * Authoring helpers for catalog entries. They only build plain descriptor
 * data — the same JSON the published catalog carries — so hand-written
 * (`bundled.ts`) and live-synthesized (`resolve.ts`) models share one shape.
 */

export const REASONING_OPTION_LABELS: Readonly<Record<string, string>> = {
	none: "None",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra High",
	max: "Max",
	ultra: "Ultra",
	ultracode: "Ultracode",
};

export const reasoningOptionLabel = (id: string): string =>
	REASONING_OPTION_LABELS[id] ??
	id.charAt(0).toUpperCase() + id.slice(1).replace(/[-_]/g, " ");

/**
 * Reasoning descriptor for Codex/Gemini/Cursor and the `reasoning` knob name
 * used across non-Claude providers. Models can append provider-supported
 * tiers beyond the standard low/medium/high set.
 */
export const reasoningSelectDescriptor = (
	defaultId: ReasoningLevel = "medium",
	additionalOptions: ReadonlyArray<{ id: ReasoningLevel; label: string }> = [],
): SelectOptionDescriptor => ({
	kind: "select",
	id: "reasoning",
	label: "Reasoning",
	options: [
		{ id: "low", label: "Low" },
		{ id: "medium", label: "Medium" },
		{ id: "high", label: "High" },
		...additionalOptions,
	],
	defaultId,
});

/**
 * Reasoning descriptor built from an arbitrary ordered list of tier ids
 * (e.g. Codex `model/list` → `supportedReasoningEfforts`).
 */
export const reasoningSelectDescriptorFromIds = (
	ids: ReadonlyArray<string>,
	defaultId?: string,
): SelectOptionDescriptor | undefined => {
	const unique = [...new Set(ids.filter((id) => id.length > 0))];
	if (unique.length === 0) return undefined;
	return {
		kind: "select",
		id: "reasoning",
		label: "Reasoning",
		options: unique.map((id) => ({ id, label: reasoningOptionLabel(id) })),
		defaultId:
			defaultId !== undefined && unique.includes(defaultId)
				? defaultId
				: unique.includes("medium")
					? "medium"
					: unique[0],
	};
};

export const extraHighReasoningOption = {
	id: "xhigh",
	label: "Extra High",
} as const;

export const codexExtendedReasoningOptions = [
	extraHighReasoningOption,
	{ id: "max", label: "Max" },
	{ id: "ultra", label: "Ultra" },
] as const;

/**
 * Standard Codex reasoning model: low → ultra tiers, plan mode, native web
 * search. `gpt56Model` in older code.
 */
export const codexReasoningModel = (
	id: string,
	label: string,
	options: {
		readonly defaultModel?: boolean;
		readonly badgeLabel?: string;
	} = {},
): ModelOption => ({
	id,
	label,
	...(options.badgeLabel !== undefined
		? { badgeLabel: options.badgeLabel }
		: {}),
	...(options.defaultModel === true ? { defaultModel: true } : {}),
	optionDescriptors: [
		reasoningSelectDescriptor("medium", codexExtendedReasoningOptions),
	],
	supportsPlanMode: true,
	supportsWebSearch: "native",
});

/**
 * Per-model effort descriptor for the Claude provider. Each model declares
 * its own supported tiers; `ultracode` is special — see `ReasoningLevel`
 * docs. The knob id is `effort` rather than `reasoning` to make driver-side
 * mapping explicit.
 */
export const claudeEffortDescriptor = (args: {
	options: ReadonlyArray<{ id: string; label: string }>;
	defaultId: string;
	promptInjectedValues?: ReadonlyArray<string>;
}): SelectOptionDescriptor => ({
	kind: "select",
	id: "effort",
	label: "Reasoning",
	options: args.options,
	defaultId: args.defaultId,
	...(args.promptInjectedValues !== undefined
		? { promptInjectedValues: args.promptInjectedValues }
		: {}),
});

export const CLAUDE_FULL_EFFORT_OPTIONS = [
	{ id: "low", label: "Low" },
	{ id: "medium", label: "Medium" },
	{ id: "high", label: "High" },
	{ id: "xhigh", label: "Extra High" },
	{ id: "max", label: "Max" },
	{ id: "ultracode", label: "Ultracode" },
] as const;

/**
 * Boolean descriptor for a per-model toggle. Used by Claude (`fastMode` halves
 * the token cost and roughly doubles throughput at the cost of some quality;
 * `thinking` enables always-on adaptive thinking) and by Codex (`fastMode` →
 * `serviceTier: "fast"`). The driver keys behavior off the descriptor `id`.
 */
export const booleanDescriptor = (
	id: string,
	label: string,
): BooleanOptionDescriptor => ({
	kind: "boolean",
	id,
	label,
});

/**
 * Standard `contextWindow` descriptor used by every Claude model that
 * supports the 1M variant. We default to `"1m"` because Anthropic routes
 * most sessions to the 1M window by default.
 */
export const claudeContextWindowDescriptor = (): SelectOptionDescriptor => ({
	kind: "select",
	id: "contextWindow",
	label: "Context Window",
	options: [
		{ id: "200k", label: "200k" },
		{ id: "1m", label: "1M" },
	],
	defaultId: "1m",
});

export const staticContextWindowDescriptor = (
	id: string,
	label: string,
): SelectOptionDescriptor => ({
	kind: "select",
	id: "contextWindow",
	label: "Context Window",
	options: [{ id, label }],
	defaultId: id,
});

/** Standard Claude Code model: full effort ladder, fast mode, 200k/1M window. */
export const claudeCodeModel = (
	id: string,
	label: string,
	options: {
		readonly defaultModel?: boolean;
		readonly badgeLabel?: string;
		readonly effortOptions?: ReadonlyArray<{ id: string; label: string }>;
		readonly fastMode?: boolean;
		readonly contextWindow?: "selectable" | "1m";
	} = {},
): ModelOption => ({
	id,
	label,
	...(options.badgeLabel !== undefined
		? { badgeLabel: options.badgeLabel }
		: {}),
	...(options.defaultModel === true ? { defaultModel: true } : {}),
	optionDescriptors: [
		claudeEffortDescriptor({
			options: options.effortOptions ?? CLAUDE_FULL_EFFORT_OPTIONS,
			defaultId: "high",
		}),
		...(options.fastMode === true
			? [booleanDescriptor("fastMode", "Fast Mode")]
			: []),
		options.contextWindow === "1m"
			? staticContextWindowDescriptor("1m", "1M")
			: claudeContextWindowDescriptor(),
	],
	supportsPlanMode: true,
	supportsWebSearch: "native",
});
