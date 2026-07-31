import type {
	LagSample,
	PerformanceConfidence,
	StallAttribution,
} from "@zuse/contracts";
import type { StallContext } from "./stall-context.ts";

const STALL_THRESHOLD_MS = 100;
const MAX_STALL_MS = 60_000;
const CONTEXT_LIMIT = 8;

interface LongAnimationFrameScript {
	readonly duration?: number;
	readonly forcedStyleAndLayoutDuration?: number;
	readonly invoker?: string;
	readonly invokerType?: string;
	readonly sourceFunctionName?: string;
	readonly sourceURL?: string;
	readonly sourceCharPosition?: number;
}

export interface LongAnimationFrameEntry {
	readonly startTime?: number;
	readonly duration: number;
	readonly blockingDuration?: number;
	readonly renderStart?: number;
	readonly styleAndLayoutStart?: number;
	readonly scripts?: ReadonlyArray<LongAnimationFrameScript>;
}

interface SampleFactories {
	readonly now?: () => string;
	readonly id?: () => string;
}

const finite = (value: number | undefined): value is number =>
	typeof value === "number" && Number.isFinite(value);

const round = (value: number): number =>
	Math.round(Math.max(0, value) * 10) / 10;

const boundedDuration = (value: number): number =>
	Math.min(MAX_STALL_MS, round(value));

const safeLabel = (value: string | undefined, fallback: string): string => {
	const sanitized = (value ?? "")
		.replace(/[^a-zA-Z0-9_.$: -]+/g, ".")
		.replace(/\.{2,}/g, ".")
		.replace(/^[.\s]+|[.\s]+$/g, "")
		.slice(0, 120);
	return sanitized || fallback;
};

const safeSource = (value: string | undefined): string | undefined => {
	if (!value) return undefined;
	const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
	if (
		scheme !== undefined &&
		scheme !== "http" &&
		scheme !== "https" &&
		scheme !== "file"
	) {
		return undefined;
	}
	const withoutQuery = value.split(/[?#]/, 1)[0] ?? "";
	const basename = withoutQuery.split(/[\\/]/).filter(Boolean).at(-1);
	if (!basename) return undefined;
	return safeLabel(basename, "script");
};

const boundedContext = (values: ReadonlyArray<string>): string[] =>
	values.slice(-CONTEXT_LIMIT).map((value) => safeLabel(value, "activity"));

const attributionContext = (
	context: StallContext,
): Pick<
	StallAttribution,
	"recentActions" | "activeWorkloads" | "relatedOperations"
> => ({
	recentActions: boundedContext(context.recentActions),
	activeWorkloads: boundedContext(context.activeWorkloads),
	relatedOperations: boundedContext(context.relatedOperations),
});

const makeId = (prefix: string): string =>
	`${prefix}_${Date.now().toString(36)}_${crypto.randomUUID?.().slice(0, 8) ?? "renderer"}`;

export function createFallbackStallAttribution(
	kind: LagSample["kind"],
	name: string | undefined,
	context: StallContext,
): StallAttribution {
	const input = kind === "input-latency";
	const rpc = kind === "rpc";
	return {
		cause: input ? "input-handler" : rpc ? "rpc" : "unknown",
		label: input
			? "Delayed input response"
			: rpc
				? safeLabel(name, "RPC operation")
				: "Browser timing unavailable",
		confidence: input || rpc ? "medium" : "low",
		...attributionContext(context),
	};
}

export function createLongAnimationFrameSample(
	entry: LongAnimationFrameEntry,
	context: StallContext,
	factories: SampleFactories = {},
): LagSample | null {
	if (!finite(entry.duration) || entry.duration < STALL_THRESHOLD_MS)
		return null;
	const scripts = (entry.scripts ?? []).filter((script) =>
		finite(script.duration),
	);
	const script = [...scripts].sort(
		(left, right) => (right.duration ?? 0) - (left.duration ?? 0),
	)[0];
	const scriptDuration = finite(script?.duration) ? script.duration : 0;
	const styleLayoutDuration = scripts.reduce(
		(total, item) =>
			total +
			(finite(item.forcedStyleAndLayoutDuration)
				? item.forcedStyleAndLayoutDuration
				: 0),
		0,
	);
	const scriptFunction = safeLabel(
		script?.sourceFunctionName,
		safeLabel(script?.invoker, "Unknown script"),
	);
	const styleDominates =
		styleLayoutDuration >= STALL_THRESHOLD_MS &&
		styleLayoutDuration >= scriptDuration * 0.4;
	const cause = styleDominates
		? ("style-layout" as const)
		: script === undefined
			? ("unknown" as const)
			: ("script" as const);
	const label =
		cause === "style-layout"
			? `Forced style/layout in ${scriptFunction}`
			: cause === "script"
				? scriptFunction
				: "Unattributed renderer work";
	const confidence: PerformanceConfidence =
		script?.sourceFunctionName || script?.sourceURL
			? "high"
			: script?.invoker
				? "medium"
				: "low";
	const startTime = finite(entry.startTime) ? entry.startTime : 0;
	const renderDuration =
		finite(entry.renderStart) && entry.renderStart >= startTime
			? Math.max(0, startTime + entry.duration - entry.renderStart)
			: undefined;
	const attribution: StallAttribution = {
		cause,
		label,
		confidence,
		...(finite(entry.blockingDuration)
			? { blockingDurationMs: boundedDuration(entry.blockingDuration) }
			: {}),
		...(renderDuration === undefined
			? {}
			: { renderDurationMs: boundedDuration(renderDuration) }),
		...(styleLayoutDuration > 0
			? { styleLayoutDurationMs: boundedDuration(styleLayoutDuration) }
			: {}),
		...(script?.invoker
			? { scriptInvoker: safeLabel(script.invoker, "script") }
			: {}),
		...(script?.sourceFunctionName
			? {
					scriptFunction: safeLabel(script.sourceFunctionName, "anonymous"),
				}
			: {}),
		...(safeSource(script?.sourceURL) === undefined
			? {}
			: { scriptSource: safeSource(script?.sourceURL) }),
		...(finite(script?.sourceCharPosition)
			? { scriptPosition: Math.max(0, Math.round(script.sourceCharPosition)) }
			: {}),
		...attributionContext(context),
	};
	return {
		id: factories.id?.() ?? makeId("lag_loaf"),
		capturedAt: factories.now?.() ?? new Date().toISOString(),
		kind: "long-animation-frame",
		durationMs: boundedDuration(entry.duration),
		source: "renderer",
		name: "renderer.long-animation-frame",
		attribution,
	};
}

export interface ReactCommitInput {
	readonly id: string;
	readonly phase: "mount" | "update" | "nested-update";
	readonly actualDurationMs: number;
	readonly baseDurationMs: number;
	readonly context: StallContext;
	readonly now?: () => string;
	readonly sampleId?: () => string;
}

export function createReactCommitLagSample(
	input: ReactCommitInput,
): LagSample | null {
	if (
		!finite(input.actualDurationMs) ||
		input.actualDurationMs < STALL_THRESHOLD_MS
	) {
		return null;
	}
	const label = `${safeLabel(input.id, "React root")} ${input.phase}`;
	return {
		id: input.sampleId?.() ?? makeId("lag_react"),
		capturedAt: input.now?.() ?? new Date().toISOString(),
		kind: "react-commit",
		durationMs: boundedDuration(input.actualDurationMs),
		source: "renderer",
		name: "renderer.react-commit",
		attribution: {
			cause: "react-render",
			label,
			confidence: input.id ? "high" : "medium",
			reactPhase: input.phase,
			reactBaseDurationMs: boundedDuration(input.baseDurationMs),
			...attributionContext(input.context),
		},
	};
}

export function createOperationLagSample(input: {
	readonly name: string;
	readonly durationMs: number;
	readonly context: StallContext;
	readonly now?: () => string;
	readonly sampleId?: () => string;
}): LagSample | null {
	if (!finite(input.durationMs) || input.durationMs < STALL_THRESHOLD_MS) {
		return null;
	}
	const label = /^[a-z0-9._-]{1,100}$/i.test(input.name)
		? input.name
		: "RPC operation";
	return {
		id: input.sampleId?.() ?? makeId("lag_rpc"),
		capturedAt: input.now?.() ?? new Date().toISOString(),
		kind: "rpc",
		durationMs: boundedDuration(input.durationMs),
		source: "renderer",
		name: "renderer.rpc",
		attribution: {
			cause: "rpc",
			label,
			confidence: "high",
			...attributionContext(input.context),
		},
	};
}
