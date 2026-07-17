import {
	type AgentAvailability,
	defaultModelFor,
	findModelDescriptor,
	MODELS_BY_PROVIDER,
	type PermissionMode,
	type ProviderId,
	type RuntimeMode,
	type SelectOptionDescriptor,
} from "@zuse/contracts";

export const PROVIDER_LABEL: Record<ProviderId, string> = {
	claude: "Claude Code",
	codex: "Codex",
	grok: "Grok",
	cursor: "Cursor",
	gemini: "Gemini",
	opencode: "OpenCode",
};

export type RuntimeOption = {
	value: RuntimeMode;
	label: string;
	systemImage: string;
	tint: string;
};

/** One visual vocabulary for runtime permissions across every mobile picker. */
export const RUNTIME_OPTION_BY_VALUE = {
	"approval-required": {
		value: "approval-required",
		label: "Ask first",
		systemImage: "hand.raised",
		tint: "#8E8E93",
	},
	"auto-accept-edits": {
		value: "auto-accept-edits",
		label: "Auto edits",
		systemImage: "pencil",
		tint: "#0A84FF",
	},
	"auto-accept-edits-and-bash": {
		value: "auto-accept-edits-and-bash",
		label: "Auto edits + shell",
		systemImage: "terminal",
		tint: "#FF9F0A",
	},
	"full-access": {
		value: "full-access",
		label: "Full access",
		systemImage: "lock.open.fill",
		tint: "#FF453A",
	},
} as const satisfies Record<RuntimeMode, RuntimeOption>;

export const RUNTIME_OPTIONS: readonly RuntimeOption[] = Object.values(
	RUNTIME_OPTION_BY_VALUE,
);

export const runtimeOptionFor = (value: RuntimeMode): RuntimeOption =>
	RUNTIME_OPTION_BY_VALUE[value];

export const PERMISSION_OPTIONS: readonly {
	value: PermissionMode;
	label: string;
}[] = [
	{ value: "default", label: "Build" },
	{ value: "plan", label: "Plan" },
	{ value: "acceptEdits", label: "Accept edits" },
];

export const providerOptions = () =>
	(Object.keys(MODELS_BY_PROVIDER) as ProviderId[]).map((providerId) => ({
		value: providerId,
		label: PROVIDER_LABEL[providerId],
	}));

export const modelOptionsForProvider = (providerId: ProviderId) =>
	(MODELS_BY_PROVIDER[providerId] ?? []).map((model) => ({
		value: model.id,
		label: model.label,
	}));

export const defaultModelForProvider = (providerId: ProviderId): string =>
	defaultModelFor(providerId);

export const reasoningDescriptorForModel = (
	providerId: ProviderId,
	model: string,
): SelectOptionDescriptor | null => {
	const descriptor = findModelDescriptor(providerId, model);
	const option = descriptor?.optionDescriptors?.find(
		(item): item is SelectOptionDescriptor =>
			item.kind === "select" &&
			(item.id === "reasoning" || item.id === "effort"),
	);
	return option ?? null;
};

/**
 * Default `modelOptions` map (just the reasoning/effort dimension) for a
 * provider+model, or `undefined` when the model exposes no reasoning
 * selection. Shared by new-chat and the composer model menu.
 */
export const defaultModelOptions = (
	providerId: ProviderId,
	model: string,
): Record<string, string> | undefined => {
	const descriptor = reasoningDescriptorForModel(providerId, model);
	const value = descriptor?.defaultId ?? descriptor?.options[0]?.id;
	return descriptor !== null && value !== undefined
		? { [descriptor.id]: value }
		: undefined;
};

/**
 * Provider ids that should appear in the model menu given an availability
 * report. Returns `null` (= no filtering, show the full catalog) when
 * availability is `null`/`undefined` — i.e. an old server that doesn't
 * report availability, or before the report has loaded. Otherwise keeps
 * providers whose `status` is `ready`/`warning` (a warning provider can still
 * run — e.g. an update is available), falling back to `cliInstalled === true`
 * when the server omitted `status`.
 */
export const availableProviderIds = (
	availability: readonly AgentAvailability[] | null | undefined,
): readonly ProviderId[] | null => {
	if (availability === null || availability === undefined) return null;
	return availability
		.filter((entry) => {
			const runtimeAvailable = entry.runtimeAvailable ?? entry.cliInstalled;
			const statusAllowsUse =
				entry.status === undefined
					? runtimeAvailable
					: entry.status === "ready" || entry.status === "warning";
			if (!statusAllowsUse) return false;
			return entry.providerId !== "cursor" || entry.hasApiKey;
		})
		.map((entry) => entry.providerId);
};

export const reasoningValueForModel = (
	providerId: ProviderId,
	model: string,
	modelOptions: Readonly<Record<string, string>> | undefined,
): {
	descriptor: SelectOptionDescriptor;
	value: string;
	label: string;
} | null => {
	const descriptor = reasoningDescriptorForModel(providerId, model);
	if (descriptor === null) return null;
	const requestedValue = modelOptions?.[descriptor.id];
	const requestedOption = descriptor.options.find(
		(option) => option.id === requestedValue,
	);
	const value =
		requestedOption?.id ?? descriptor.defaultId ?? descriptor.options[0]?.id;
	if (value === undefined) return null;
	const label =
		descriptor.options.find((option) => option.id === value)?.label ?? value;
	return { descriptor, value, label };
};
