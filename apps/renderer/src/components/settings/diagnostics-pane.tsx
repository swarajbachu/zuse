import {
	formatDate as formatUiDate,
	formatNumber as formatUiNumber,
} from "@zuse/i18n";
import { isInputComposing } from "../../lib/input-composition.ts";
import "@zuse/i18n/english/settings";
import type {
	CommandId,
	DiagnosticEvent,
	DiagnosticSeverity,
	DiagnosticsCaptureResult,
	DiagnosticsEventsResult,
	DiagnosticsExportResult,
	DiagnosticsOverviewResult,
	DiagnosticsProcessesResult,
	DiagnosticsSignalResult,
	EnvironmentId,
	LagSample,
	PerformanceHistory,
	PowerMonitorState,
	PowerRecordingDurationMinutes,
} from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import { RichMessage, useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	Activity,
	AlertTriangle,
	Archive,
	Check,
	ChevronDown,
	Copy,
	ExternalLink,
	FolderOpen,
	Gauge,
	HardDrive,
	ListTodo,
	Pause,
	Play,
	RefreshCw,
	ScrollText,
	Search,
	Server,
	ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useMediaQuery } from "../../hooks/use-media-query.ts";
import { collectDiagnosticsClientContext } from "../../lib/diagnostics-client-context.ts";
import {
	flushRendererDiagnostics,
	getPowerInteractionMeasurements,
} from "../../lib/diagnostics-recorder.ts";
import {
	DEFAULT_DIAGNOSTICS_PREFERENCES,
	DIAGNOSTICS_PREFERENCES_KEY,
	DIAGNOSTICS_RANGE_OPTIONS,
	type DiagnosticsCaptureDuration,
	type DiagnosticsPreferences,
	type DiagnosticsSeverityFilter,
	type DiagnosticsView,
	diagnosticsCaptureErrorMessage,
	diagnosticsCapturePayload,
	diagnosticsSeveritySelection,
	diagnosticsSince,
	formatCaptureCountdown,
	groupDiagnosticEvents,
	parseDiagnosticsPreferences,
	relatedDiagnosticEvents,
} from "../../lib/diagnostics-view-model.ts";
import { dispatchEnvironmentShellCommand } from "../../lib/environment-shell-client-bus.ts";
import { cn } from "../../lib/utils.ts";
import { useEnvironmentCatalogStore } from "../../store/environment-catalog.ts";
import { Area } from "../dither-kit/area.tsx";
import { AreaChart } from "../dither-kit/area-chart.tsx";
import { Sparkline as DitherSparkline } from "../dither-kit/sparkline.tsx";
import { Tooltip as DitherTooltip } from "../dither-kit/tooltip.tsx";
import { Button } from "../ui/button.tsx";
import {
	Dialog,
	DialogDescription,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "../ui/dialog.tsx";
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from "../ui/frame.tsx";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "../ui/select.tsx";

const VIEW_OPTIONS: ReadonlyArray<{
	readonly id: DiagnosticsView;
	readonly label: string;
	readonly icon: typeof ListTodo;
}> = [
	{
		id: "issues",
		get label() {
			return uiMessage("settings:diagnostics_pane_issues");
		},
		icon: ListTodo,
	},
	{
		id: "logs",
		get label() {
			return uiMessage("settings:diagnostics_pane_logs");
		},
		icon: ScrollText,
	},
	{
		id: "performance",
		get label() {
			return uiMessage("settings:diagnostics_pane_performance");
		},
		icon: Gauge,
	},
	{
		id: "processes",
		get label() {
			return uiMessage("settings:diagnostics_pane_processes");
		},
		icon: Server,
	},
	{
		id: "storage",
		get label() {
			return uiMessage("settings:diagnostics_pane_storage");
		},
		icon: HardDrive,
	},
];

const formatCount = { format: formatUiNumber };
const formatBytes = (bytes: number) => {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
};
const formatDuration = (milliseconds: number) =>
	milliseconds < 1_000
		? `${Math.round(milliseconds)} ms`
		: `${(milliseconds / 1_000).toFixed(2)} s`;
const relativeTime = (value: string) => {
	const seconds = Math.max(
		0,
		Math.round((Date.now() - new Date(value).getTime()) / 1_000),
	);
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
	return `${Math.floor(seconds / 86_400)}d ago`;
};
const formatTimestamp = (value: string) =>
	formatUiDate(new Date(value), {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		fractionalSecondDigits: 3,
	});

const readPreferences = (): DiagnosticsPreferences => {
	if (typeof window === "undefined") return DEFAULT_DIAGNOSTICS_PREFERENCES;
	try {
		return parseDiagnosticsPreferences(
			window.localStorage.getItem(DIAGNOSTICS_PREFERENCES_KEY),
		);
	} catch {
		return DEFAULT_DIAGNOSTICS_PREFERENCES;
	}
};

function SeverityPill({ severity }: { severity: DiagnosticSeverity }) {
	return (
		<span
			className={cn(
				"inline-flex rounded-md px-1.5 py-0.5 font-medium text-[9px] uppercase tracking-[0.08em]",
				severity === "fatal" || severity === "error"
					? "bg-destructive/12 text-destructive"
					: severity === "warn"
						? "bg-warning/12 text-warning"
						: "bg-muted text-muted-foreground",
			)}
		>
			{severity}
		</span>
	);
}

function MetricSparkline({
	values,
	color,
	label,
}: {
	readonly values: ReadonlyArray<number>;
	readonly color: "grey" | "orange" | "red";
	readonly label: string;
}) {
	const chartValues: number[] =
		values.length === 0
			? [0, 0]
			: values.length === 1
				? [values[0] ?? 0, values[0] ?? 0]
				: Array.from(values);
	return (
		<div className="h-[30px] w-28 shrink-0" role="img" aria-label={label}>
			<DitherSparkline
				data={chartValues}
				color={color}
				variant="gradient"
				animate={false}
				className="[&_canvas]:opacity-45"
			/>
		</div>
	);
}

function PulseMetric({
	label,
	value,
	tone = "default",
	values,
}: {
	readonly label: string;
	readonly value: string;
	readonly tone?: "default" | "warning" | "danger";
	readonly values?: ReadonlyArray<number>;
}) {
	return (
		<div className="flex min-h-[68px] min-w-0 items-center justify-between gap-3 px-4 py-3">
			<div className="min-w-0">
				<p className="truncate font-medium text-[9px] text-muted-foreground uppercase tracking-[0.12em]">
					{label}
				</p>
				<p
					className={cn(
						"mt-1 truncate font-mono font-medium text-base tabular-nums",
						tone === "danger" && "text-destructive",
						tone === "warning" && "text-warning",
					)}
				>
					{value}
				</p>
			</div>
			{values && (
				<MetricSparkline
					values={values}
					label={uiMessage("settings:diagnostics_pane_live_trend", {
						label: String(label),
					})}
					color={
						tone === "danger" ? "red" : tone === "warning" ? "orange" : "grey"
					}
				/>
			)}
		</div>
	);
}

function ResourceChart({
	label,
	value,
	peak,
	values,
	formatValue,
	color,
}: {
	readonly label: string;
	readonly value: number;
	readonly peak: number;
	readonly values: ReadonlyArray<number>;
	readonly formatValue: (value: number) => string;
	readonly color: "blue" | "green" | "orange" | "red";
}) {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const chartValues: number[] =
		values.length === 0
			? [0, 0]
			: values.length === 1
				? [values[0] ?? 0, values[0] ?? 0]
				: Array.from(values);
	const chartData = chartValues.map((sample, index) => ({
		sample: `Sample ${index + 1}`,
		value: sample,
	}));
	const chartConfig = { value: { label, color } } as const;
	return (
		<div className="min-w-0 p-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<p className="font-medium text-[10px] text-muted-foreground">
						{label}
					</p>
					<p className="mt-0.5 font-mono text-sm tabular-nums">
						{formatValue(value)}
					</p>
				</div>
				<p className="pt-0.5 text-[9px] text-muted-foreground">
					<RichMessage
						id="settings:diagnostics_pane_peak_sentence"
						values={{ value: formatValue(peak) }}
						components={{ part0: <span className="font-mono" /> }}
					/>
				</p>
			</div>
			<div
				className="mt-3 block h-28 w-full"
				role="img"
				aria-label={uiMessage("settings:diagnostics_pane_peak_2", {
					label: String(label),
					value2: String(formatValue(value)),
					value3: String(formatValue(peak)),
				})}
			>
				<AreaChart
					data={chartData}
					config={chartConfig}
					margins={{ top: 3, right: 3, bottom: 3, left: 3 }}
					animate={false}
					bloom="off"
					className="[&_canvas]:opacity-55 hover:[&_canvas]:opacity-70"
				>
					<Area dataKey="value" variant="gradient" />
					<DitherTooltip
						labelKey="sample"
						valueFormatter={(sample) => formatValue(sample)}
					/>
				</AreaChart>
			</div>
			<p className="text-[9px] text-muted-foreground">
				{uiMessage(
					"settings:diagnostics_pane_live_samples_from_this_page_session",
				)}
			</p>
		</div>
	);
}

function EmptyState({
	icon: Icon = ShieldCheck,
	title,
	description,
}: {
	readonly icon?: typeof ShieldCheck;
	readonly title: string;
	readonly description: string;
}) {
	return (
		<div className="flex min-h-56 flex-col items-center justify-center px-6 text-center">
			<div className="flex size-9 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
				<Icon className="size-4" />
			</div>
			<p className="mt-3 font-medium text-[12px]">{title}</p>
			<p className="mt-1 max-w-72 text-[10px] text-muted-foreground leading-4">
				{description}
			</p>
		</div>
	);
}

function CopyButton({
	copyKey,
	copiedKey,
	onCopy,
	text,
	label,
}: {
	readonly copyKey: string;
	readonly copiedKey: string | null;
	readonly onCopy: (key: string, text: string) => void;
	readonly text: string;
	readonly label: string;
}) {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const copied = copiedKey === copyKey;
	return (
		<Button
			size="sm"
			variant="settings"
			className="h-7 gap-1.5 px-2.5 !text-[10px] [&_svg]:size-3.5"
			onClick={() => onCopy(copyKey, text)}
		>
			{copied ? <Check /> : <Copy />}
			{copied ? uiMessage("common:copied") : label}
		</Button>
	);
}

function DiagnosticsFilters({
	search,
	onSearchChange,
	severity,
	onSeverityChange,
	source,
	onSourceChange,
	rangeMs,
	onRangeChange,
	searchLabel,
}: {
	readonly search: string;
	readonly onSearchChange: (value: string) => void;
	readonly severity: DiagnosticsSeverityFilter;
	readonly onSeverityChange: (value: DiagnosticsSeverityFilter) => void;
	readonly source: string;
	readonly onSourceChange: (value: string) => void;
	readonly rangeMs: number;
	readonly onRangeChange: (value: number) => void;
	readonly searchLabel: string;
}) {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	return (
		<div className="flex flex-wrap items-center gap-2 border-b border-border/45 p-2.5">
			<label className="relative min-w-48 flex-1">
				<span className="sr-only">{searchLabel}</span>
				<Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<input
					type="search"
					value={search}
					onChange={(event) => onSearchChange(event.target.value)}
					className="h-7 w-full rounded-md border border-input bg-card pl-8 pr-2 text-[11px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/24 pointer-coarse:text-base"
					placeholder={uiMessage(
						"settings:diagnostics_pane_search_messages_and_details",
					)}
					spellCheck={false}
				/>
			</label>
			<label>
				<span className="sr-only">
					{uiMessage("settings:diagnostics_pane_filter_by_severity")}
				</span>
				<select
					value={severity}
					onChange={(event) =>
						onSeverityChange(event.target.value as DiagnosticsSeverityFilter)
					}
					className="h-7 rounded-md border border-input bg-card px-2 text-[10px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/24 pointer-coarse:text-base"
				>
					<option value="all">
						{uiMessage("settings:diagnostics_pane_all_levels")}
					</option>
					<option value="fatal">
						{uiMessage("settings:diagnostics_pane_fatal")}
					</option>
					<option value="error">
						{uiMessage("settings:diagnostics_pane_errors")}
					</option>
					<option value="warn">
						{uiMessage("settings:diagnostics_pane_warnings")}
					</option>
					<option value="info">
						{uiMessage("settings:diagnostics_pane_info")}
					</option>
					<option value="debug">
						{uiMessage("settings:diagnostics_pane_debug")}
					</option>
				</select>
			</label>
			<label className="min-w-36 flex-1 sm:max-w-48">
				<span className="sr-only">
					{uiMessage("settings:diagnostics_pane_filter_by_source")}
				</span>
				<input
					value={source}
					onChange={(event) => onSourceChange(event.target.value)}
					className="h-7 w-full rounded-md border border-input bg-card px-2 text-[10px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/24 pointer-coarse:text-base"
					placeholder={uiMessage("settings:diagnostics_pane_all_sources")}
					spellCheck={false}
				/>
			</label>
			<fieldset className="relative flex h-7 rounded-md border border-input bg-card p-0.5">
				<legend className="sr-only">
					{uiMessage("settings:diagnostics_pane_diagnostics_time_range")}
				</legend>
				{DIAGNOSTICS_RANGE_OPTIONS.map((option) => (
					<button
						type="button"
						key={option.label}
						aria-pressed={rangeMs === option.milliseconds}
						onClick={() => onRangeChange(option.milliseconds)}
						className={cn(
							"h-6 min-w-8 rounded-sm px-1.5 font-mono text-[9px] outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11",
							rangeMs === option.milliseconds
								? "bg-muted text-foreground shadow-xs"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{option.label}
					</button>
				))}
			</fieldset>
		</div>
	);
}

function IncidentDetails({
	selected,
	related,
	copiedKey,
	onCopy,
}: {
	readonly selected: DiagnosticEvent | null;
	readonly related: ReadonlyArray<DiagnosticEvent>;
	readonly copiedKey: string | null;
	readonly onCopy: (key: string, text: string) => void;
}) {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	if (!selected) {
		return (
			<EmptyState
				title={uiMessage("settings:diagnostics_pane_select_an_issue")}
				description={uiMessage(
					"settings:diagnostics_pane_its_sanitized_details_related_occurrences_and_correlation_ids_will_app",
				)}
			/>
		);
	}

	return (
		<div className="min-w-0">
			<div className="border-b border-border/45 p-4">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<SeverityPill severity={selected.severity} />
						<h3 className="mt-2 text-balance font-medium text-[12px] leading-5">
							{selected.message}
						</h3>
						<p className="mt-1 font-mono text-[9px] text-muted-foreground">
							{selected.source} · {relativeTime(selected.createdAt)}
						</p>
					</div>
					<Button
						size="icon-sm"
						variant="ghost"
						aria-label={
							copiedKey === "diagnostic-id"
								? uiMessage("settings:diagnostics_pane_diagnostic_id_copied")
								: uiMessage("settings:diagnostics_pane_copy_diagnostic_id")
						}
						onClick={() => onCopy("diagnostic-id", selected.id)}
					>
						{copiedKey === "diagnostic-id" ? <Check /> : <Copy />}
					</Button>
				</div>
			</div>

			<div className="space-y-4 p-4">
				<dl className="grid grid-cols-[82px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[10px]">
					<dt className="text-muted-foreground">
						{uiMessage("settings:diagnostics_pane_diagnostic_id")}
					</dt>
					<dd className="truncate font-mono" title={selected.id}>
						{selected.id}
					</dd>
					<dt className="text-muted-foreground">
						{uiMessage("settings:diagnostics_pane_run")}
					</dt>
					<dd className="truncate font-mono">{selected.runId}</dd>
					<dt className="text-muted-foreground">
						{uiMessage("settings:diagnostics_pane_recovery")}
					</dt>
					<dd className="capitalize">{selected.recoveryStatus}</dd>
					<dt className="text-muted-foreground">
						{uiMessage("settings:diagnostics_pane_trace")}
					</dt>
					<dd className="truncate font-mono">
						{selected.traceId ??
							uiMessage("settings:diagnostics_pane_not_correlated")}
					</dd>
					<dt className="text-muted-foreground">
						{uiMessage("settings:diagnostics_pane_session")}
					</dt>
					<dd className="truncate font-mono">
						{selected.sessionId ??
							selected.chatId ??
							uiMessage("settings:diagnostics_pane_not_correlated")}
					</dd>
					<dt className="text-muted-foreground">
						{uiMessage("settings:diagnostics_pane_provider")}
					</dt>
					<dd className="truncate font-mono">
						{selected.providerId ??
							uiMessage("settings:diagnostics_pane_not_correlated")}
					</dd>
				</dl>

				{selected.detail ? (
					<div>
						<p className="mb-1.5 font-medium text-[10px]">
							{uiMessage("settings:diagnostics_pane_sanitized_details")}
						</p>
						<pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-[9px] leading-4">
							{selected.detail}
						</pre>
					</div>
				) : (
					<p className="rounded-md bg-muted/35 px-3 py-2 text-[10px] text-muted-foreground">
						{uiMessage(
							"settings:diagnostics_pane_no_additional_stack_or_cause_was_captured",
						)}
					</p>
				)}

				<div>
					<div className="mb-1.5 flex items-center justify-between">
						<p className="font-medium text-[10px]">
							{uiMessage("settings:diagnostics_pane_related_occurrences")}
						</p>
						<span className="font-mono text-[9px] text-muted-foreground tabular-nums">
							{uiMessage("settings:diagnostics_pane_loaded_sentence", {
								value: related.length,
							})}
						</span>
					</div>
					<div className="max-h-36 divide-y divide-border/40 overflow-auto rounded-md border border-border/45">
						{related.slice(0, 12).map((item, index) => (
							<div
								key={`${item.id}:${index}`}
								className="flex items-center justify-between gap-3 px-2.5 py-2 text-[9px]"
							>
								<span className="truncate font-mono text-muted-foreground">
									{item.id}
								</span>
								<span className="shrink-0 font-mono text-muted-foreground tabular-nums">
									{relativeTime(item.createdAt)}
								</span>
							</div>
						))}
					</div>
				</div>

				<CopyButton
					copyKey="incident-details"
					copiedKey={copiedKey}
					onCopy={onCopy}
					label={uiMessage("settings:diagnostics_pane_copy_details")}
					text={`${selected.id}\n${selected.message}\n${selected.detail ?? ""}`}
				/>
			</div>
		</div>
	);
}

function ContextList({
	label,
	values,
}: {
	readonly label: string;
	readonly values: ReadonlyArray<string>;
}) {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	return (
		<div className="min-w-0 rounded-md border border-border/45 bg-muted/20 p-2.5">
			<p className="text-[10px] text-muted-foreground uppercase tracking-wider">
				{label}
			</p>
			<p className="mt-1.5 break-words font-mono text-[10px] leading-4">
				{values.length > 0
					? values.join(" · ")
					: uiMessage("settings:diagnostics_pane_none_captured")}
			</p>
		</div>
	);
}

function StallWorkspace({
	samples,
	selectedId,
	onSelect,
	copiedKey,
	onCopy,
}: {
	readonly samples: ReadonlyArray<LagSample>;
	readonly selectedId: string | null;
	readonly onSelect: (id: string) => void;
	readonly copiedKey: string | null;
	readonly onCopy: (key: string, text: string) => void;
}) {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const ordered = [...samples]
		.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
		.slice(0, 24);
	const selected =
		ordered.find((sample) => sample.id === selectedId) ?? ordered[0] ?? null;
	const attribution = selected?.attribution;
	const details =
		selected === null
			? ""
			: [
					`Stall: ${selected.id}`,
					`Captured: ${selected.capturedAt}`,
					`Duration: ${selected.durationMs.toFixed(1)} ms`,
					`Type: ${selected.kind}`,
					`Cause: ${attribution?.label ?? "Unattributed"}`,
					`Confidence: ${attribution?.confidence ?? "low"}`,
					attribution?.blockingDurationMs === undefined
						? null
						: `Blocking: ${attribution.blockingDurationMs.toFixed(1)} ms`,
					attribution?.styleLayoutDurationMs === undefined
						? null
						: `Style/layout: ${attribution.styleLayoutDurationMs.toFixed(1)} ms`,
					attribution?.scriptFunction
						? `Function: ${attribution.scriptFunction}`
						: null,
					attribution?.scriptSource
						? `Source: ${attribution.scriptSource}${attribution.scriptPosition === undefined ? "" : `:${attribution.scriptPosition}`}`
						: null,
					attribution?.recentActions.length
						? `Recent actions: ${attribution.recentActions.join(", ")}`
						: null,
					attribution?.activeWorkloads.length
						? `Active workloads: ${attribution.activeWorkloads.join(", ")}`
						: null,
					attribution?.relatedOperations.length
						? `Related operations: ${attribution.relatedOperations.join(", ")}`
						: null,
				]
					.filter(Boolean)
					.join("\n");

	return (
		<section className="min-w-0 border-t border-border/45">
			<div className="flex min-h-10 items-center justify-between gap-3 border-b border-border/45 px-4 py-2.5">
				<div>
					<h3 className="font-medium text-[11px]">
						{uiMessage("settings:diagnostics_pane_stall_cause_timeline")}
					</h3>
					<p className="mt-0.5 text-[10px] text-muted-foreground">
						{uiMessage(
							"settings:diagnostics_pane_sanitized_script_layout_action_and_workload_attribution_react_commit_t",
						)}
					</p>
				</div>
				<span className="font-mono text-[10px] text-muted-foreground tabular-nums">
					{uiMessage("settings:diagnostics_pane_retained_sentence", {
						value: ordered.length,
					})}
				</span>
			</div>
			{selected === null ? (
				<div className="min-h-[280px]">
					<EmptyState
						title={uiMessage("settings:diagnostics_pane_no_interface_stalls")}
						description={uiMessage(
							"settings:diagnostics_pane_stalls_of_at_least_100_ms_will_appear_with_the_strongest_locally_avail",
						)}
					/>
				</div>
			) : (
				<div className="grid min-h-[280px] lg:grid-cols-[minmax(260px,0.85fr)_minmax(0,1.35fr)] lg:divide-x lg:divide-border/45">
					<fieldset className="max-h-[360px] divide-y divide-border/40 overflow-auto">
						<legend className="sr-only">
							{uiMessage("settings:diagnostics_pane_interface_stalls")}
						</legend>
						{ordered.map((sample) => {
							const active = sample.id === selected.id;
							return (
								<button
									key={sample.id}
									type="button"
									aria-pressed={active}
									onClick={() => onSelect(sample.id)}
									className={cn(
										"grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11",
										active ? "bg-muted/70" : "hover:bg-muted/35",
									)}
								>
									<RichMessage
										id="settings:diagnostics_pane_confidence_sentence"
										values={{
											value:
												sample.attribution?.label ?? sample.name ?? sample.kind,
											value2: sample.attribution?.cause ?? sample.kind,
											value3: sample.attribution?.confidence ?? "low",
											value4: formatDuration(sample.durationMs),
											value5: relativeTime(sample.capturedAt),
										}}
										components={{
											part0: <span className="min-w-0" />,
											part1: (
												<span className="block truncate font-medium text-[11px]" />
											),
											part2: (
												<span className="mt-0.5 block truncate text-[10px] text-muted-foreground" />
											),
											part3: <span className="text-right" />,
											part4: (
												<span className="block font-mono text-[11px] tabular-nums" />
											),
											part5: (
												<span className="mt-0.5 block font-mono text-[10px] text-muted-foreground tabular-nums" />
											),
										}}
									/>
								</button>
							);
						})}
					</fieldset>
					<div className="border-t border-border/45 p-4 lg:border-t-0">
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<p className="truncate font-medium text-xs">
									{attribution?.label ??
										uiMessage("settings:diagnostics_pane_cause_unavailable")}
								</p>
								<p className="mt-1 text-[10px] text-muted-foreground">
									{uiMessage(
										"settings:diagnostics_pane_confidence_sentence_2",
										{
											value: attribution?.confidence ?? "low",
											value2: selected.kind,
										},
									)}
								</p>
							</div>
							<CopyButton
								copyKey={`stall:${selected.id}`}
								copiedKey={copiedKey}
								onCopy={onCopy}
								label={uiMessage("common:copy")}
								text={details}
							/>
						</div>
						<div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-2 text-[10px]">
							<span className="text-muted-foreground">
								{uiMessage("settings:diagnostics_pane_total_duration")}
							</span>
							<span className="text-right font-mono tabular-nums">
								{formatDuration(selected.durationMs)}
							</span>
							<span className="text-muted-foreground">
								{uiMessage("settings:diagnostics_pane_main_thread_blocking")}
							</span>
							<span className="text-right font-mono tabular-nums">
								{attribution?.blockingDurationMs === undefined
									? uiMessage("settings:diagnostics_pane_unavailable")
									: formatDuration(attribution.blockingDurationMs)}
							</span>
							<span className="text-muted-foreground">
								{uiMessage("settings:diagnostics_pane_style_and_layout")}
							</span>
							<span className="text-right font-mono tabular-nums">
								{attribution?.styleLayoutDurationMs === undefined
									? uiMessage("settings:diagnostics_pane_unavailable")
									: formatDuration(attribution.styleLayoutDurationMs)}
							</span>
							<span className="text-muted-foreground">
								{uiMessage("settings:diagnostics_pane_script")}
							</span>
							<span className="truncate text-right font-mono">
								{attribution?.scriptSource === undefined
									? uiMessage("settings:diagnostics_pane_unavailable")
									: `${attribution.scriptSource}${attribution.scriptPosition === undefined ? "" : `:${attribution.scriptPosition}`}`}
							</span>
							<span className="text-muted-foreground">
								{uiMessage("settings:diagnostics_pane_function")}
							</span>
							<span className="truncate text-right font-mono">
								{attribution?.scriptFunction ??
									attribution?.scriptInvoker ??
									uiMessage("settings:diagnostics_pane_unavailable")}
							</span>
						</div>
						<div className="mt-4 grid gap-3 sm:grid-cols-3">
							<ContextList
								label={uiMessage("settings:diagnostics_pane_recent_actions")}
								values={attribution?.recentActions ?? []}
							/>
							<ContextList
								label={uiMessage("settings:diagnostics_pane_active_workloads")}
								values={attribution?.activeWorkloads ?? []}
							/>
							<ContextList
								label={uiMessage(
									"settings:diagnostics_pane_related_operations",
								)}
								values={attribution?.relatedOperations ?? []}
							/>
						</div>
					</div>
				</div>
			)}
		</section>
	);
}

export function DiagnosticsPane() {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const environmentId = useEnvironmentCatalogStore(
		(state) => state.activeEnvironmentId as EnvironmentId,
	);
	const command = useCallback(
		<Result, Payload = unknown>(kind: string, payload: Payload) =>
			dispatchEnvironmentShellCommand<Payload, Result>({
				environmentId,
				kind,
				commandId: crypto.randomUUID() as CommandId,
				payload,
			}).then(({ result }) => result),
		[environmentId],
	);
	const initialPreferences = useRef(readPreferences()).current;
	const mainLogsIngestedRef = useRef(false);
	const copyTimerRef = useRef<number | null>(null);
	const incidentListRef = useRef<HTMLDivElement | null>(null);
	const isNarrow = useMediaQuery("max-xl");
	const [overview, setOverview] = useState<DiagnosticsOverviewResult | null>(
		null,
	);
	const [events, setEvents] = useState<ReadonlyArray<DiagnosticEvent>>([]);
	const [nextEventCursor, setNextEventCursor] = useState<string | null>(null);
	const [eventTotal, setEventTotal] = useState(0);
	const [processes, setProcesses] = useState<DiagnosticsProcessesResult | null>(
		null,
	);
	const [performanceHistory, setPerformanceHistory] =
		useState<PerformanceHistory | null>(null);
	const [powerState, setPowerState] = useState<PowerMonitorState | null>(null);
	const [recordingDuration, setRecordingDuration] =
		useState<PowerRecordingDurationMinutes>(5);
	const [recordingBusy, setRecordingBusy] = useState<
		"starting" | "stopping" | "exporting" | null
	>(null);
	const [captureDuration, setCaptureDuration] =
		useState<DiagnosticsCaptureDuration>(5);
	const [captureBusy, setCaptureBusy] = useState(false);
	const [captureNow, setCaptureNow] = useState(Date.now());
	const [selected, setSelected] = useState<DiagnosticEvent | null>(null);
	const [selectedLagId, setSelectedLagId] = useState<string | null>(null);
	const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
	const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
	const [view, setView] = useState<DiagnosticsView>(initialPreferences.view);
	const [live, setLive] = useState(true);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [exporting, setExporting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [search, setSearch] = useState(initialPreferences.search);
	const [source, setSource] = useState(initialPreferences.source);
	const [querySearch, setQuerySearch] = useState(initialPreferences.search);
	const [querySource, setQuerySource] = useState(initialPreferences.source);
	const [severity, setSeverity] = useState<DiagnosticsSeverityFilter>(
		initialPreferences.severity,
	);
	const [rangeMs, setRangeMs] = useState(initialPreferences.rangeMs);
	const [copiedKey, setCopiedKey] = useState<string | null>(null);
	const [samples, setSamples] = useState<
		ReadonlyArray<{
			at: string;
			cpu: number;
			memory: number;
			failures: number;
		}>
	>([]);

	useEffect(() => {
		const timer = window.setTimeout(() => {
			setQuerySearch(search.trim());
			setQuerySource(source.trim());
		}, 300);
		return () => window.clearTimeout(timer);
	}, [search, source]);

	useEffect(() => {
		try {
			window.localStorage.setItem(
				DIAGNOSTICS_PREFERENCES_KEY,
				JSON.stringify({ view, rangeMs, severity, source, search }),
			);
		} catch {
			// The workspace remains usable when local storage is unavailable.
		}
	}, [rangeMs, search, severity, source, view]);

	useEffect(
		() => () => {
			if (copyTimerRef.current !== null) {
				window.clearTimeout(copyTimerRef.current);
			}
		},
		[],
	);

	useEffect(() => {
		const power = (window.zuse ?? window.memoize)?.power;
		if (!power) return;
		void power
			.getState()
			.then(setPowerState)
			.catch(() => undefined);
		return power.onState(setPowerState);
	}, []);

	useEffect(() => {
		if (overview?.captureMode !== "full") return;
		const timer = window.setInterval(() => setCaptureNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [overview?.captureMode]);

	const refresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await flushRendererDiagnostics();
			if (!mainLogsIngestedRef.current) {
				try {
					const mainLogs =
						(await window.zuse?.app?.getMainDiagnostics?.().catch(() => [])) ??
						[];
					const unpublishedMainLogs = mainLogs.filter(
						(log) => log.source !== "main.previousRunUnclean",
					);
					if (unpublishedMainLogs.length > 0) {
						await command("diagnostics.ingest", {
							events: unpublishedMainLogs.map((log, index) => ({
								id: `main_${log.createdAt}_${index}`,
								createdAt: log.createdAt,
								severity: log.level,
								source: log.source,
								category: "desktop",
								message: log.message,
								...(log.detail ? { detail: log.detail } : {}),
								fingerprint: `${log.source}:${log.message}`,
								runId: "desktop-main",
								recoveryStatus:
									log.level === "error" ? "unresolved" : "not-needed",
							})),
						});
					}
					mainLogsIngestedRef.current = true;
				} catch {
					// Main-process ingestion is best effort and must not block inspection.
				}
			}

			const since = diagnosticsSince(rangeMs);
			const selectedSeverities = diagnosticsSeveritySelection(view, severity);
			const power = (window.zuse ?? window.memoize)?.power;
			const [overviewResult, eventsResult, processesResult, performanceResult] =
				await Promise.allSettled([
					command<DiagnosticsOverviewResult>("diagnostics.overview", { since }),
					command<DiagnosticsEventsResult>("diagnostics.events", {
						limit: 200,
						since,
						...(selectedSeverities === undefined
							? {}
							: { severities: selectedSeverities }),
						...(querySource ? { source: querySource } : {}),
						...(querySearch ? { search: querySearch } : {}),
					}),
					command<DiagnosticsProcessesResult>("diagnostics.processes", {}),
					power?.getHistory(Date.now() - rangeMs) ??
						Promise.reject(new Error("Native performance bridge unavailable.")),
				]);

			const failures: string[] = [];
			if (overviewResult.status === "fulfilled") {
				setOverview(overviewResult.value);
			} else {
				failures.push("health overview");
			}
			if (eventsResult.status === "fulfilled") {
				setEvents(eventsResult.value.events);
				setNextEventCursor(eventsResult.value.nextCursor);
				setEventTotal(eventsResult.value.total);
			} else {
				failures.push("issue list");
			}
			if (processesResult.status === "fulfilled") {
				setProcesses(processesResult.value);
				setSamples((current) =>
					[
						...current,
						{
							at: processesResult.value.readAt,
							cpu: processesResult.value.totalCpuPercent,
							memory: processesResult.value.totalRssBytes,
							failures:
								overviewResult.status === "fulfilled"
									? overviewResult.value.errorCount +
										overviewResult.value.fatalCount
									: (current.at(-1)?.failures ?? 0),
						},
					].slice(-720),
				);
			} else {
				failures.push("process sample");
			}
			if (performanceResult.status === "fulfilled") {
				setPerformanceHistory(performanceResult.value);
			} else {
				failures.push("performance history");
			}
			setError(
				failures.length > 0
					? `Some diagnostics could not refresh: ${failures.join(", ")}. Showing the latest available data.`
					: null,
			);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Diagnostics could not be refreshed.",
			);
		} finally {
			setLoading(false);
			setRefreshing(false);
		}
	}, [command, querySearch, querySource, rangeMs, severity, view]);

	useEffect(() => {
		void refresh();
	}, [refresh]);
	useEffect(() => {
		if (!live) return;
		const timer = window.setInterval(() => void refresh(), 5_000);
		return () => window.clearInterval(timer);
	}, [live, refresh]);

	useEffect(() => {
		setSelected((current) => {
			if (!current) return null;
			return (
				events.find((event) => event.id === current.id) ??
				events.find((event) => event.fingerprint === current.fingerprint) ??
				null
			);
		});
	}, [events]);

	const loadMoreEvents = async () => {
		if (!nextEventCursor) return;
		try {
			const selectedSeverities = diagnosticsSeveritySelection(view, severity);
			const page = await command<DiagnosticsEventsResult>(
				"diagnostics.events",
				{
					cursor: nextEventCursor,
					limit: 200,
					since: diagnosticsSince(rangeMs),
					...(selectedSeverities === undefined
						? {}
						: { severities: selectedSeverities }),
					...(querySource ? { source: querySource } : {}),
					...(querySearch ? { search: querySearch } : {}),
				},
			);
			setEvents((current) => [...current, ...page.events]);
			setNextEventCursor(page.nextCursor);
			setEventTotal(page.total);
			setError(null);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "More issues could not be loaded.",
			);
		}
	};

	const exportBundle = async () => {
		setExporting(true);
		try {
			const clientContext = await collectDiagnosticsClientContext();
			const result = await command<DiagnosticsExportResult>(
				"diagnostics.export",
				{
					clientContext,
					since: diagnosticsSince(rangeMs),
					includeSessionEvents: false,
				},
			);
			await (window.zuse ?? window.memoize)?.app?.revealPath?.(
				result.bundlePath,
			);
			setError(null);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Support bundle export failed.",
			);
		} finally {
			setExporting(false);
		}
	};

	const updateCapture = async () => {
		setCaptureBusy(true);
		try {
			const result = await command<DiagnosticsCaptureResult>(
				"diagnostics.capture",
				diagnosticsCapturePayload(
					overview?.captureMode ?? "incident",
					captureDuration,
				),
			);
			setCaptureNow(Date.now());
			setOverview((current) =>
				current === null ? current : { ...current, ...result },
			);
			setError(null);
		} catch (cause) {
			setError(diagnosticsCaptureErrorMessage(cause));
		} finally {
			setCaptureBusy(false);
		}
	};

	const signalProcess = async (
		pid: number,
		signal: "interrupt" | "terminate" | "kill",
	) => {
		if (
			signal === "kill" &&
			!window.confirm(
				`Force quit process ${pid}? Unsaved subprocess work may be lost.`,
			)
		)
			return;
		try {
			const result = await command<DiagnosticsSignalResult>(
				"diagnostics.signalProcess",
				{ pid, signal },
			);
			if (!result.signaled) {
				setError(result.message ?? "The process could not be signaled.");
			}
			await refresh();
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "The process action failed.",
			);
		}
	};

	const startPerformanceRecording = async () => {
		const power = (window.zuse ?? window.memoize)?.power;
		if (!power) {
			setError("Native performance recording is unavailable.");
			return;
		}
		setRecordingBusy("starting");
		try {
			setPowerState(await power.startRecording(recordingDuration));
			setError(null);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Performance recording could not start.",
			);
		} finally {
			setRecordingBusy(null);
		}
	};

	const stopPerformanceRecording = async () => {
		const power = (window.zuse ?? window.memoize)?.power;
		if (!power) return;
		setRecordingBusy("stopping");
		try {
			setPowerState(await power.stopRecording());
			await refresh();
			setError(null);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Performance recording could not stop.",
			);
		} finally {
			setRecordingBusy(null);
		}
	};

	const exportPerformanceRecording = async () => {
		const power = (window.zuse ?? window.memoize)?.power;
		const recording = powerState?.latestRecording;
		if (!power || !recording) return;
		setRecordingBusy("exporting");
		try {
			await power.exportLatestRecording(
				getPowerInteractionMeasurements(recording.startedAt),
			);
			setError(null);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Performance recording could not be exported.",
			);
		} finally {
			setRecordingBusy(null);
		}
	};

	const clearPerformanceHistory = async () => {
		if (
			!window.confirm(
				"Clear local performance and lag history? Diagnostic errors and exported recordings are not removed.",
			)
		) {
			return;
		}
		try {
			await (window.zuse ?? window.memoize)?.power?.clearHistory();
			setPerformanceHistory(null);
			await refresh();
			setError(null);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Performance history could not be cleared.",
			);
		}
	};

	const copyText = (key: string, text: string) => {
		void navigator.clipboard
			.writeText(text)
			.then(() => {
				setCopiedKey(key);
				if (copyTimerRef.current !== null) {
					window.clearTimeout(copyTimerRef.current);
				}
				copyTimerRef.current = window.setTimeout(
					() => setCopiedKey(null),
					1_500,
				);
			})
			.catch(() => setError("The diagnostic details could not be copied."));
	};

	const commonCounts = useMemo(
		() =>
			new Map(
				overview?.commonFailures.map((group) => [
					group.fingerprint,
					group.count,
				]) ?? [],
			),
		[overview, uiMessage],
	);
	const incidents = useMemo(
		() => groupDiagnosticEvents(events, commonCounts),
		[commonCounts, events, uiMessage],
	);
	const related = useMemo(
		() =>
			selected ? relatedDiagnosticEvents(events, selected.fingerprint) : [],
		[events, selected, uiMessage],
	);
	const resourceSamples = performanceHistory?.samples.slice(-240) ?? [];
	const lagSamples = performanceHistory?.lagSamples.slice(-240) ?? [];
	const performanceOverview = performanceHistory?.overview;
	const latestPowerSnapshot =
		powerState?.latestSnapshot ?? resourceSamples.at(-1) ?? null;
	const resourceMaxCpu = Math.max(
		1,
		...resourceSamples.map((sample) => sample.totalCpuPercent),
	);
	const resourceMaxMemory = Math.max(
		1,
		...resourceSamples.map((sample) => sample.totalMemoryBytes),
	);
	const maxWakeups = Math.max(
		1,
		...resourceSamples.map((sample) => sample.totalIdleWakeupsPerSecond),
	);
	const maxLag = Math.max(1, ...lagSamples.map((sample) => sample.durationMs));
	const failureCount =
		(overview?.errorCount ?? 0) + (overview?.fatalCount ?? 0);
	const statusTone =
		overview?.status === "failing"
			? "text-destructive"
			: overview?.status === "degraded"
				? "text-warning"
				: "text-success";

	const selectIncident = (event: DiagnosticEvent) => {
		setSelected(event);
		if (isNarrow) setMobileDetailsOpen(true);
	};

	return (
		<div className="flex min-w-0 flex-col gap-3 pb-12 text-[11px]">
			<Frame
				aria-label={uiMessage("settings:diagnostics_pane_diagnostics_status")}
			>
				<FrameHeader className="flex w-full flex-row flex-wrap items-center justify-between gap-3 px-3 py-2.5">
					<div className="flex min-w-0 items-center gap-2.5">
						<div
							className={cn(
								"flex size-7 items-center justify-center rounded-md border border-border/45 bg-muted/50",
								statusTone,
							)}
						>
							<Activity className="size-3.5" />
						</div>
						<div className="min-w-0">
							<p className="truncate font-medium text-[11px] capitalize">
								{overview?.status ?? (loading ? "Checking" : "Unavailable")}
							</p>
							<p className="truncate font-mono text-[9px] text-muted-foreground tabular-nums">
								{overview
									? uiMessage("settings:diagnostics_pane_unseen", {
											unseenCount: String(overview.unseenCount),
											value2: String(live ? "Live capture" : "Updates paused"),
											value3: String(relativeTime(overview.readAt)),
										})
									: uiMessage(
											"settings:diagnostics_pane_reading_local_diagnostics",
										)}
							</p>
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-1.5">
						<Button
							size="sm"
							variant="settings"
							className="h-7 min-w-24 gap-1.5 px-2.5 !text-[10px] [&_svg]:size-3.5"
							onClick={() => setLive((value) => !value)}
						>
							{live ? <Pause /> : <Play />}
							{live
								? uiMessage("settings:diagnostics_pane_pause_live")
								: uiMessage("settings:diagnostics_pane_resume_live")}
						</Button>
						<Button
							size="sm"
							variant="settings"
							className="h-7 min-w-24 gap-1.5 px-2.5 !text-[10px] [&_svg]:size-3.5"
							loading={refreshing}
							onClick={() => void refresh()}
						>
							<RefreshCw />
							{uiMessage("common:refresh")}
						</Button>
						<Button
							size="sm"
							variant="settings"
							className="h-7 min-w-24 gap-1.5 px-2.5 !text-[10px] [&_svg]:size-3.5"
							onClick={() =>
								void (
									window.zuse ?? window.memoize
								)?.app?.revealDiagnosticsLogs?.()
							}
						>
							<FolderOpen />
							{uiMessage("settings:diagnostics_pane_open_logs")}
						</Button>
						<Button
							size="sm"
							className="h-7 gap-1.5 px-2.5 !text-[10px] [&_svg]:size-3.5"
							loading={exporting}
							onClick={() => void exportBundle()}
						>
							<Archive />
							{uiMessage("settings:diagnostics_pane_export_support_bundle")}
						</Button>
					</div>
				</FrameHeader>
				<FramePanel className="grid min-h-[68px] grid-cols-2 divide-x divide-y divide-border/45 p-0 lg:grid-cols-5 lg:divide-y-0">
					<PulseMetric
						label={uiMessage("settings:diagnostics_pane_failures")}
						value={overview ? formatCount.format(failureCount) : "—"}
						tone={failureCount > 0 ? "danger" : "default"}
						values={samples.map((sample) => sample.failures)}
					/>
					<PulseMetric
						label={uiMessage("settings:diagnostics_pane_warnings")}
						value={overview ? formatCount.format(overview.warningCount) : "—"}
						tone={(overview?.warningCount ?? 0) > 0 ? "warning" : "default"}
					/>
					<PulseMetric
						label={uiMessage("settings:diagnostics_pane_cpu")}
						value={processes ? `${processes.totalCpuPercent.toFixed(1)}%` : "—"}
						values={samples.map((sample) => sample.cpu)}
					/>
					<PulseMetric
						label={uiMessage("settings:diagnostics_pane_memory")}
						value={processes ? formatBytes(processes.totalRssBytes) : "—"}
						values={samples.map((sample) => sample.memory)}
					/>
					<PulseMetric
						label={uiMessage("settings:diagnostics_pane_stored_locally")}
						value={overview ? formatBytes(overview.storageBytes) : "—"}
					/>
				</FramePanel>
			</Frame>

			{error && (
				<div
					role="alert"
					className="flex min-h-10 items-start gap-2 rounded-lg bg-alert-error-bg px-3 py-2 text-[10px] text-destructive"
				>
					<AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
					<span className="flex-1">{error}</span>
					<Button
						size="xs"
						variant="ghost"
						className="h-6 !text-[9px]"
						onClick={() => void refresh()}
					>
						{uiMessage("common:retry")}
					</Button>
				</div>
			)}

			<nav
				aria-label={uiMessage("settings:diagnostics_pane_diagnostics_views")}
				className="flex min-h-9 items-center gap-1 overflow-x-auto rounded-lg border border-border/55 bg-muted/25 p-1"
			>
				{VIEW_OPTIONS.map((option) => {
					const Icon = option.icon;
					const active = view === option.id;
					return (
						<button
							type="button"
							key={option.id}
							aria-current={active ? "page" : undefined}
							onClick={() => setView(option.id)}
							className={cn(
								"flex h-7 min-w-24 items-center justify-center gap-1.5 rounded-md px-3 font-medium text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11",
								active
									? "bg-foreground text-background shadow-xs"
									: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
							)}
						>
							<Icon className="size-3.5" />
							{option.label}
						</button>
					);
				})}
			</nav>

			{view === "issues" && (
				<Frame
					aria-label={uiMessage(
						"settings:diagnostics_pane_issue_triage_workspace",
					)}
				>
					<FrameHeader className="flex w-full flex-row flex-wrap items-center justify-between gap-3 px-3 py-2.5">
						<div>
							<FrameTitle className="text-[12px]">
								{uiMessage("settings:diagnostics_pane_issue_inbox")}
							</FrameTitle>
							<FrameDescription className="text-[9px] leading-3.5">
								{uiMessage(
									"settings:diagnostics_pane_repeated_failures_are_grouped_so_the_most_important_work_stays_visible",
								)}
							</FrameDescription>
						</div>
						<p className="font-mono text-[9px] text-muted-foreground tabular-nums">
							{uiMessage("settings:diagnostics_pane_groups_events_sentence", {
								value: formatCount.format(incidents.length),
								value2: formatCount.format(eventTotal),
							})}
						</p>
					</FrameHeader>
					<FramePanel className="overflow-hidden p-0">
						<DiagnosticsFilters
							search={search}
							onSearchChange={setSearch}
							severity={severity}
							onSeverityChange={setSeverity}
							source={source}
							onSourceChange={setSource}
							rangeMs={rangeMs}
							onRangeChange={setRangeMs}
							searchLabel="Search diagnostic issues"
						/>

						<div className="grid min-h-[480px] min-w-0 xl:grid-cols-[minmax(0,1fr)_340px]">
							<div className="min-w-0 xl:border-r xl:border-border/45">
								<div
									ref={incidentListRef}
									className="max-h-[620px] divide-y divide-border/40 overflow-auto"
								>
									{incidents.map((incident, incidentIndex) => {
										const item = incident.event;
										return (
											<button
												type="button"
												key={item.fingerprint}
												onClick={() => selectIncident(item)}
												onFocus={(event) =>
													event.currentTarget.scrollIntoView({
														block: "nearest",
													})
												}
												onKeyDown={(event) => {
													if (isInputComposing(event)) return;

													if (
														event.key !== "ArrowDown" &&
														event.key !== "ArrowUp"
													) {
														return;
													}
													event.preventDefault();
													const nextIndex = Math.min(
														incidents.length - 1,
														Math.max(
															0,
															incidentIndex +
																(event.key === "ArrowDown" ? 1 : -1),
														),
													);
													incidentListRef.current
														?.querySelector<HTMLButtonElement>(
															`[data-incident-index="${nextIndex}"]`,
														)
														?.focus();
												}}
												data-incident-index={incidentIndex}
												className={cn(
													"grid min-h-16 w-full grid-cols-[70px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left outline-none hover:bg-muted/25 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
													selected?.fingerprint === item.fingerprint &&
														"bg-muted/40",
												)}
											>
												<SeverityPill severity={item.severity} />
												<span className="min-w-0">
													<span className="block truncate font-medium text-[11px]">
														{item.message}
													</span>
													<span className="mt-1 block truncate font-mono text-[9px] text-muted-foreground">
														{item.source}
														{item.sessionId
															? uiMessage(
																	"settings:diagnostics_pane_session_2",
																	{ value1: String(item.sessionId) },
																)
															: ""}
													</span>
												</span>
												<span className="text-right">
													<span className="block font-mono text-[10px] tabular-nums">
														{incident.occurrences > 1
															? `${incident.occurrences}×`
															: uiMessage("settings:diagnostics_pane_once")}
													</span>
													<span className="mt-1 block whitespace-nowrap font-mono text-[9px] text-muted-foreground">
														{relativeTime(item.createdAt)}
													</span>
												</span>
											</button>
										);
									})}
									{!loading && incidents.length === 0 && (
										<EmptyState
											title={uiMessage(
												"settings:diagnostics_pane_no_matching_issues",
											)}
											description={uiMessage(
												"settings:diagnostics_pane_change_the_filters_or_time_range_healthy_captures_will_appear_here_onl",
											)}
										/>
									)}
									{loading && incidents.length === 0 && (
										<EmptyState
											icon={Activity}
											title={uiMessage(
												"settings:diagnostics_pane_checking_the_system",
											)}
											description={uiMessage(
												"settings:diagnostics_pane_reading_recent_incidents_and_correlating_local_process_state",
											)}
										/>
									)}
								</div>
								{nextEventCursor && (
									<div className="flex min-h-11 items-center justify-between border-t border-border/45 px-4 py-2 text-[9px] text-muted-foreground">
										<span className="font-mono tabular-nums">
											{uiMessage(
												"settings:diagnostics_pane_of_events_loaded_sentence",
												{
													value: formatCount.format(events.length),
													value2: formatCount.format(eventTotal),
												},
											)}
										</span>
										<Button
											size="sm"
											variant="settings"
											className="h-7 px-2.5 !text-[10px]"
											onClick={() => void loadMoreEvents()}
										>
											{uiMessage("settings:diagnostics_pane_load_more")}
										</Button>
									</div>
								)}
							</div>
							<aside
								className="hidden min-w-0 xl:block"
								aria-label={uiMessage(
									"settings:diagnostics_pane_issue_details",
								)}
							>
								<IncidentDetails
									selected={selected}
									related={related}
									copiedKey={copiedKey}
									onCopy={copyText}
								/>
							</aside>
						</div>
					</FramePanel>
				</Frame>
			)}

			{view === "logs" && (
				<Frame
					aria-label={uiMessage(
						"settings:diagnostics_pane_live_diagnostic_logs",
					)}
				>
					<FrameHeader className="flex w-full flex-row flex-wrap items-center justify-between gap-3 px-3 py-2.5">
						<div>
							<FrameTitle className="flex items-center gap-2 text-[12px]">
								{uiMessage("settings:diagnostics_pane_live_logs")}
								<span
									className={cn(
										"inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-normal text-[9px]",
										live
											? "bg-success/10 text-success"
											: "bg-muted text-muted-foreground",
									)}
								>
									<span
										className={cn(
											"size-1.5 rounded-full",
											live ? "bg-success" : "bg-muted-foreground/60",
										)}
									/>
									{live
										? uiMessage("settings:diagnostics_pane_following")
										: uiMessage("settings:diagnostics_pane_paused")}
								</span>
							</FrameTitle>
							<FrameDescription className="text-[9px] leading-3.5">
								{uiMessage(
									"settings:diagnostics_pane_structured_local_events_the_newest_filtered_page_refreshes_every_five",
								)}
							</FrameDescription>
						</div>
						<p
							className="font-mono text-[9px] text-muted-foreground tabular-nums"
							aria-live="polite"
						>
							{uiMessage("settings:diagnostics_pane_loaded_matching_sentence", {
								value: formatCount.format(events.length),
								value2: formatCount.format(eventTotal),
							})}
						</p>
					</FrameHeader>
					<FramePanel className="overflow-hidden p-0">
						<DiagnosticsFilters
							search={search}
							onSearchChange={setSearch}
							severity={severity}
							onSeverityChange={setSeverity}
							source={source}
							onSourceChange={setSource}
							rangeMs={rangeMs}
							onRangeChange={setRangeMs}
							searchLabel="Search diagnostic logs"
						/>

						<div className="overflow-x-auto">
							<div className="min-w-[760px]">
								<div className="grid h-8 grid-cols-[86px_72px_150px_minmax(240px,1fr)_128px_24px] items-center gap-3 border-b border-border/45 px-4 font-medium text-[9px] text-muted-foreground uppercase tracking-[0.08em]">
									<RichMessage
										id="settings:diagnostics_pane_timelevelsourcemessagetracedetails_sentence"
										components={{
											part0: <span />,
											part1: <span />,
											part2: <span />,
											part3: <span />,
											part4: <span />,
											part5: <span className="sr-only" />,
										}}
									/>
								</div>
								<div className="max-h-[620px] divide-y divide-border/40 overflow-y-auto">
									{events.map((item) => {
										const expanded = expandedLogId === item.id;
										return (
											<div key={item.id}>
												<button
													type="button"
													aria-expanded={expanded}
													onClick={() =>
														setExpandedLogId(expanded ? null : item.id)
													}
													className={cn(
														"grid min-h-10 w-full grid-cols-[86px_72px_150px_minmax(240px,1fr)_128px_24px] items-center gap-3 px-4 text-left outline-none hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
														expanded && "bg-muted/30",
													)}
												>
													<time
														dateTime={item.createdAt}
														title={formatUiDate(new Date(item.createdAt), {
															year: "numeric",
															month: "numeric",
															day: "numeric",
															hour: "numeric",
															minute: "numeric",
															second: "numeric",
														})}
														className="font-mono text-[9px] text-muted-foreground tabular-nums"
													>
														{formatTimestamp(item.createdAt)}
													</time>
													<SeverityPill severity={item.severity} />
													<span
														className="truncate font-mono text-[9px] text-muted-foreground"
														title={item.source}
													>
														{item.source}
													</span>
													<span
														className="truncate text-[10px]"
														title={item.message}
													>
														{item.message}
													</span>
													<span
														className="truncate font-mono text-[9px] text-muted-foreground"
														title={
															item.traceId ??
															uiMessage(
																"settings:diagnostics_pane_not_correlated",
															)
														}
													>
														{item.traceId ?? "—"}
													</span>
													<ChevronDown
														className={cn(
															"size-3.5 text-muted-foreground",
															expanded && "rotate-180",
														)}
													/>
												</button>
												{expanded && (
													<div className="grid gap-4 border-t border-border/30 bg-muted/15 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_260px]">
														<div className="min-w-0">
															<p className="font-medium text-[9px] text-muted-foreground uppercase tracking-[0.08em]">
																{uiMessage(
																	"settings:diagnostics_pane_sanitized_detail",
																)}
															</p>
															{item.detail ? (
																<pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-3 font-mono text-[9px] leading-4">
																	{item.detail}
																</pre>
															) : (
																<p className="mt-2 text-[10px] text-muted-foreground">
																	{uiMessage(
																		"settings:diagnostics_pane_no_additional_detail_was_captured_for_this_event",
																	)}
																</p>
															)}
														</div>
														<div className="min-w-0">
															<dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-[9px]">
																<dt className="text-muted-foreground">
																	{uiMessage("settings:diagnostics_pane_event")}
																</dt>
																<dd
																	className="truncate font-mono"
																	title={item.id}
																>
																	{item.id}
																</dd>
																<dt className="text-muted-foreground">
																	{uiMessage(
																		"settings:diagnostics_pane_category",
																	)}
																</dt>
																<dd className="truncate">{item.category}</dd>
																<dt className="text-muted-foreground">
																	{uiMessage("settings:diagnostics_pane_run")}
																</dt>
																<dd className="truncate font-mono">
																	{item.runId}
																</dd>
																<dt className="text-muted-foreground">
																	{uiMessage("settings:diagnostics_pane_span")}
																</dt>
																<dd className="truncate font-mono">
																	{item.spanId ?? "—"}
																</dd>
																<dt className="text-muted-foreground">
																	{uiMessage(
																		"settings:diagnostics_pane_session",
																	)}
																</dt>
																<dd className="truncate font-mono">
																	{item.sessionId ?? item.chatId ?? "—"}
																</dd>
																<dt className="text-muted-foreground">
																	{uiMessage(
																		"settings:diagnostics_pane_provider",
																	)}
																</dt>
																<dd className="truncate font-mono">
																	{item.providerId ?? "—"}
																</dd>
															</dl>
															<div className="mt-3">
																<CopyButton
																	copyKey={`log:${item.id}`}
																	copiedKey={copiedKey}
																	onCopy={copyText}
																	label={uiMessage(
																		"settings:diagnostics_pane_copy_event",
																	)}
																	text={`${item.createdAt}\n${item.severity.toUpperCase()} ${item.source}\n${item.message}\nEvent: ${item.id}\nTrace: ${item.traceId ?? "—"}\n${item.detail ?? ""}`}
																/>
															</div>
														</div>
													</div>
												)}
											</div>
										);
									})}
									{!loading && events.length === 0 && (
										<EmptyState
											icon={ScrollText}
											title={uiMessage(
												"settings:diagnostics_pane_no_matching_logs",
											)}
											description={uiMessage(
												"settings:diagnostics_pane_change_the_filters_or_time_range_new_structured_events_will_appear_her",
											)}
										/>
									)}
									{loading && events.length === 0 && (
										<EmptyState
											icon={Activity}
											title={uiMessage(
												"settings:diagnostics_pane_reading_live_logs",
											)}
											description={uiMessage(
												"settings:diagnostics_pane_loading_the_newest_structured_events_from_local_diagnostics",
											)}
										/>
									)}
								</div>
							</div>
						</div>
						<div className="flex min-h-11 items-center justify-between border-t border-border/45 px-4 py-2 text-[9px] text-muted-foreground">
							<span>
								{live
									? uiMessage(
											"settings:diagnostics_pane_following_the_newest_events",
										)
									: uiMessage(
											"settings:diagnostics_pane_live_refresh_is_paused",
										)}
							</span>
							{nextEventCursor && (
								<Button
									size="sm"
									variant="settings"
									className="h-7 px-2.5 !text-[10px]"
									onClick={() => void loadMoreEvents()}
								>
									{uiMessage("settings:diagnostics_pane_load_older")}
								</Button>
							)}
						</div>
					</FramePanel>
				</Frame>
			)}

			{view === "performance" && (
				<Frame
					aria-label={uiMessage(
						"settings:diagnostics_pane_performance_diagnostics",
					)}
				>
					<FrameHeader className="flex w-full flex-row flex-wrap items-center justify-between gap-3 px-3 py-2.5">
						<div>
							<FrameTitle className="text-[12px]">
								{uiMessage("settings:diagnostics_pane_performance_and_energy")}
							</FrameTitle>
							<FrameDescription className="text-[9px] leading-3.5">
								{uiMessage(
									"settings:diagnostics_pane_local_resource_responsiveness_battery_and_thermal_telemetry_with_confi",
								)}
							</FrameDescription>
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<div className="flex rounded-md border border-border/45 bg-background/40 p-0.5">
								{DIAGNOSTICS_RANGE_OPTIONS.map((option) => (
									<button
										type="button"
										key={option.label}
										aria-pressed={rangeMs === option.milliseconds}
										onClick={() => setRangeMs(option.milliseconds)}
										className={cn(
											"h-6 min-w-8 rounded-[5px] px-1.5 font-mono text-[9px] outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:min-w-11",
											rangeMs === option.milliseconds
												? "bg-muted text-foreground shadow-xs"
												: "text-muted-foreground hover:text-foreground",
										)}
									>
										{option.label}
									</button>
								))}
							</div>
							<span className="font-mono text-[9px] text-muted-foreground tabular-nums">
								{performanceHistory
									? uiMessage("settings:diagnostics_pane_samples", {
											value1: String(performanceHistory.samples.length),
										})
									: uiMessage(
											"settings:diagnostics_pane_loading_local_history",
										)}
							</span>
						</div>
					</FrameHeader>
					<FramePanel className="overflow-hidden p-0">
						<div className="grid grid-cols-2 divide-x divide-y divide-border/45 lg:grid-cols-5 lg:divide-y-0">
							<PulseMetric
								label={uiMessage("settings:diagnostics_pane_responsiveness")}
								value={performanceOverview?.responsiveness ?? "—"}
								tone={
									performanceOverview?.responsiveness === "poor"
										? "danger"
										: performanceOverview?.responsiveness === "degraded"
											? "warning"
											: "default"
								}
							/>
							<PulseMetric
								label={uiMessage("settings:diagnostics_pane_cpu")}
								value={
									latestPowerSnapshot
										? `${latestPowerSnapshot.totalCpuPercent.toFixed(1)}%`
										: "—"
								}
								values={resourceSamples.map((sample) => sample.totalCpuPercent)}
							/>
							<PulseMetric
								label={uiMessage("settings:diagnostics_pane_memory")}
								value={
									latestPowerSnapshot
										? formatBytes(latestPowerSnapshot.totalMemoryBytes)
										: "—"
								}
								values={resourceSamples.map(
									(sample) => sample.totalMemoryBytes,
								)}
							/>
							<PulseMetric
								label={uiMessage("settings:diagnostics_pane_battery_impact")}
								value={
									performanceOverview?.batteryDrainPercentPerHour !== null &&
									performanceOverview?.batteryDrainPercentPerHour !== undefined
										? `${performanceOverview.batteryDrainPercentPerHour.toFixed(1)}%/h`
										: "Measuring"
								}
								tone={
									(performanceOverview?.batteryDrainPercentPerHour ?? 0) >= 25
										? "warning"
										: "default"
								}
							/>
							<PulseMetric
								label={uiMessage("settings:diagnostics_pane_thermal_pressure")}
								value={latestPowerSnapshot?.thermalState ?? "Unavailable"}
								tone={
									latestPowerSnapshot?.thermalState === "critical" ||
									latestPowerSnapshot?.thermalState === "serious"
										? "danger"
										: latestPowerSnapshot?.thermalState === "fair"
											? "warning"
											: "default"
								}
							/>
						</div>
						<div className="grid divide-y divide-border/45 border-t border-border/45 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
							<ResourceChart
								label={uiMessage("settings:diagnostics_pane_cpu_usage")}
								value={latestPowerSnapshot?.totalCpuPercent ?? 0}
								peak={resourceMaxCpu}
								values={resourceSamples.map((sample) => sample.totalCpuPercent)}
								formatValue={(value) => `${value.toFixed(1)}%`}
								color="blue"
							/>
							<ResourceChart
								label={uiMessage("settings:diagnostics_pane_memory_usage")}
								value={latestPowerSnapshot?.totalMemoryBytes ?? 0}
								peak={resourceMaxMemory}
								values={resourceSamples.map(
									(sample) => sample.totalMemoryBytes,
								)}
								formatValue={formatBytes}
								color="orange"
							/>
						</div>
						<div className="grid border-t border-border/45 lg:grid-cols-2 lg:divide-x lg:divide-border/45">
							<ResourceChart
								label={uiMessage("settings:diagnostics_pane_idle_wakeups")}
								value={latestPowerSnapshot?.totalIdleWakeupsPerSecond ?? 0}
								peak={maxWakeups}
								values={resourceSamples.map(
									(sample) => sample.totalIdleWakeupsPerSecond,
								)}
								formatValue={(value) => `${value.toFixed(1)}/s`}
								color="green"
							/>
							<ResourceChart
								label={uiMessage("settings:diagnostics_pane_interface_stalls")}
								value={lagSamples.at(-1)?.durationMs ?? 0}
								peak={maxLag}
								values={lagSamples.map((sample) => sample.durationMs)}
								formatValue={formatDuration}
								color="red"
							/>
						</div>
						<StallWorkspace
							samples={lagSamples}
							selectedId={selectedLagId}
							onSelect={setSelectedLagId}
							copiedKey={copiedKey}
							onCopy={copyText}
						/>
						<div className="grid border-t border-border/45 lg:grid-cols-2 lg:divide-x lg:divide-border/45">
							<section className="min-w-0">
								<div className="border-b border-border/45 px-4 py-2.5">
									<h3 className="font-medium text-[10px]">
										{uiMessage(
											"settings:diagnostics_pane_what_made_zuse_heavy",
										)}
									</h3>
								</div>
								{performanceOverview?.incidents.length ? (
									<div className="divide-y divide-border/40">
										{performanceOverview.incidents.slice(0, 8).map((item) => (
											<div
												key={item.id}
												className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3"
											>
												<div className="min-w-0">
													<p
														className={cn(
															"truncate font-medium text-[10px]",
															item.severity === "error" && "text-destructive",
															item.severity === "warn" && "text-warning",
														)}
													>
														{item.message}
													</p>
													<p className="mt-1 truncate text-[9px] text-muted-foreground">
														{item.likelyContributor
															? uiMessage(
																	"settings:diagnostics_pane_likely_contributor",
																	{ value1: String(item.likelyContributor) },
																)
															: uiMessage(
																	"settings:diagnostics_pane_no_single_workload_could_be_attributed",
																)}
													</p>
												</div>
												<div className="text-right">
													<p className="font-mono text-[10px] tabular-nums">
														{item.unit === "bytes"
															? formatBytes(item.value)
															: `${item.value.toFixed(1)} ${item.unit}`}
													</p>
													<p className="mt-1 text-[8px] text-muted-foreground uppercase tracking-wider">
														{uiMessage(
															"settings:diagnostics_pane_confidence_sentence_3",
															{ value: item.confidence },
														)}
													</p>
												</div>
											</div>
										))}
									</div>
								) : (
									<EmptyState
										title={uiMessage(
											"settings:diagnostics_pane_no_sustained_pressure",
										)}
										description={uiMessage(
											"settings:diagnostics_pane_short_spikes_are_retained_in_charts_sustained_cpu_memory_battery_therm",
										)}
									/>
								)}
							</section>
							<section className="min-w-0 border-t border-border/45 lg:border-t-0">
								<div className="border-b border-border/45 px-4 py-2.5">
									<h3 className="font-medium text-[10px]">
										{uiMessage("settings:diagnostics_pane_process_hotspots")}
									</h3>
								</div>
								{performanceOverview?.hotspots.length ? (
									<div className="divide-y divide-border/40">
										{performanceOverview.hotspots.slice(0, 8).map((item) => (
											<div
												key={`${item.processType}:${item.pid}`}
												className="grid grid-cols-[minmax(0,1fr)_repeat(3,64px)] gap-2 px-4 py-3 text-[9px]"
											>
												<span className="truncate font-medium text-[10px]">
													{item.name ?? item.processType}
													<span className="ml-1 font-mono text-[8px] text-muted-foreground">
														{item.pid}
													</span>
												</span>
												<span
													className="text-right font-mono tabular-nums"
													title={uiMessage(
														"settings:diagnostics_pane_average_cpu",
													)}
												>
													{item.averageCpuPercent.toFixed(1)}%
												</span>
												<span
													className="text-right font-mono tabular-nums"
													title={uiMessage(
														"settings:diagnostics_pane_peak_memory",
													)}
												>
													{formatBytes(item.peakMemoryBytes)}
												</span>
												<span
													className="text-right font-mono tabular-nums"
													title={uiMessage(
														"settings:diagnostics_pane_idle_wakeups_per_second",
													)}
												>
													{item.averageIdleWakeupsPerSecond.toFixed(1)}/s
												</span>
											</div>
										))}
									</div>
								) : (
									<EmptyState
										title={uiMessage(
											"settings:diagnostics_pane_no_process_history",
										)}
										description={uiMessage(
											"settings:diagnostics_pane_process_cpu_memory_and_wakeups_appear_after_the_first_native_sample",
										)}
									/>
								)}
							</section>
						</div>
						<div className="grid border-t border-border/45 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.75fr)] lg:divide-x lg:divide-border/45">
							<section className="min-w-0">
								<div className="border-b border-border/45 px-4 py-2.5">
									<h3 className="font-medium text-[10px]">
										{uiMessage(
											"settings:diagnostics_pane_slow_operations_and_trace_health",
										)}
									</h3>
								</div>
								{overview?.slowestOperations.length ? (
									<div className="divide-y divide-border/40">
										{overview.slowestOperations.slice(0, 6).map((item) => (
											<div
												key={item.id}
												className="flex items-center justify-between gap-4 px-4 py-3"
											>
												<div className="min-w-0">
													<p className="truncate font-medium text-[10px]">
														{item.message}
													</p>
													<p className="mt-1 truncate font-mono text-[9px] text-muted-foreground">
														{item.traceId ?? item.id}
													</p>
												</div>
												<span className="font-mono text-[10px] tabular-nums">
													{formatDuration(item.durationMs ?? 0)}
												</span>
											</div>
										))}
									</div>
								) : (
									<EmptyState
										title={uiMessage(
											"settings:diagnostics_pane_no_slow_operations",
										)}
										description={uiMessage(
											"settings:diagnostics_pane_instrumented_operations_taking_at_least_one_second_will_appear_here",
										)}
									/>
								)}
							</section>
							<section className="min-w-0 border-t border-border/45 p-4 lg:border-t-0">
								<h3 className="font-medium text-[10px]">
									{uiMessage("settings:diagnostics_pane_performance_recording")}
								</h3>
								<p className="mt-1 text-[9px] leading-4 text-muted-foreground">
									{uiMessage(
										"settings:diagnostics_pane_captures_five_second_process_samples_locally_energy_readings_are_estim",
									)}
								</p>
								{powerState?.activeRecording ? (
									<div className="mt-3 rounded-md border border-border/45 bg-muted/25 p-3">
										<div className="flex items-center justify-between gap-3">
											<div>
												<p className="font-medium text-[10px]">
													{uiMessage(
														"settings:diagnostics_pane_recording_in_progress",
													)}
												</p>
												<p className="mt-1 font-mono text-[9px] text-muted-foreground tabular-nums">
													{powerState.activeRecording.sampleCount}
													{uiMessage("settings:diagnostics_pane_samples_ends")}{" "}
													{formatTimestamp(powerState.activeRecording.endsAt)}
													{powerState.activeRecording.deepProfileStatus
														? uiMessage("settings:diagnostics_pane_energy", {
																value1: String(
																	powerState.activeRecording.deepProfileStatus,
																),
															})
														: ""}
												</p>
											</div>
											<Button
												size="sm"
												variant="settings"
												className="h-7 min-w-24 !text-[10px]"
												loading={recordingBusy === "stopping"}
												onClick={() => void stopPerformanceRecording()}
											>
												{uiMessage("settings:diagnostics_pane_stop_recording")}
											</Button>
										</div>
									</div>
								) : (
									<div className="mt-3 flex flex-wrap items-center gap-2">
										<label
											htmlFor="performance-recording-duration"
											className="sr-only"
										>
											{uiMessage(
												"settings:diagnostics_pane_recording_duration",
											)}
										</label>
										<select
											id="performance-recording-duration"
											value={recordingDuration}
											onChange={(event) =>
												setRecordingDuration(
													Number(
														event.currentTarget.value,
													) as PowerRecordingDurationMinutes,
												)
											}
											className="h-7 rounded-md border border-border/55 bg-background px-2 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11"
										>
											<option value={5}>
												{uiMessage("settings:diagnostics_pane_5_minutes")}
											</option>
											<option value={15}>
												{uiMessage("settings:diagnostics_pane_15_minutes")}
											</option>
											<option value={30}>
												{uiMessage("settings:diagnostics_pane_30_minutes")}
											</option>
										</select>
										<Button
											size="sm"
											className="h-7 min-w-24 !text-[10px]"
											loading={recordingBusy === "starting"}
											onClick={() => void startPerformanceRecording()}
										>
											{uiMessage("settings:diagnostics_pane_start_recording")}
										</Button>
										<Button
											size="sm"
											variant="settings"
											className="h-7 min-w-24 !text-[10px]"
											disabled={!powerState?.latestRecording}
											loading={recordingBusy === "exporting"}
											onClick={() => void exportPerformanceRecording()}
										>
											{uiMessage("settings:diagnostics_pane_export_latest")}
										</Button>
									</div>
								)}
								<div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[9px] text-muted-foreground">
									<span>
										{uiMessage("settings:diagnostics_pane_battery_source")}
									</span>
									<span className="text-right font-mono">
										{latestPowerSnapshot?.powerSource ??
											uiMessage("settings:diagnostics_pane_unknown")}
									</span>
									<span>
										{uiMessage("settings:diagnostics_pane_temperature_sensor")}
									</span>
									<span className="text-right">
										{performanceHistory?.capabilities.exactTemperature.state ===
										"supported"
											? uiMessage("settings:diagnostics_pane_available")
											: uiMessage("settings:diagnostics_pane_unavailable")}
									</span>
									<span>
										{uiMessage(
											"settings:diagnostics_pane_local_resource_storage",
										)}
									</span>
									<span className="text-right font-mono">
										{formatBytes(performanceHistory?.storageBytes ?? 0)}
									</span>
									{powerState?.latestRecording?.deepEnergy?.status ===
										"complete" && (
										<>
											<span>
												{uiMessage(
													"settings:diagnostics_pane_latest_combined_package_power",
												)}
											</span>
											<span className="text-right font-mono">
												{powerState.latestRecording.deepEnergy
													.combinedPowerMw === null
													? uiMessage("settings:diagnostics_pane_unavailable")
													: uiMessage("settings:diagnostics_pane_mw", {
															value1: String(
																powerState.latestRecording.deepEnergy.combinedPowerMw.toFixed(
																	0,
																),
															),
														})}
											</span>
										</>
									)}
								</div>
							</section>
						</div>
					</FramePanel>
				</Frame>
			)}

			{view === "processes" && (
				<Frame
					aria-label={uiMessage("settings:diagnostics_pane_live_processes")}
				>
					<FrameHeader className="flex w-full flex-row items-center justify-between gap-3 px-3 py-2.5">
						<div>
							<FrameTitle className="text-[12px]">
								{uiMessage("settings:diagnostics_pane_live_processes")}
							</FrameTitle>
							<FrameDescription className="text-[9px] leading-3.5">
								{uiMessage(
									"settings:diagnostics_pane_server_owned_helpers_process_ancestry_is_validated_again_before_every",
								)}
							</FrameDescription>
						</div>
						<p className="shrink-0 font-mono text-[9px] text-muted-foreground tabular-nums">
							{uiMessage("settings:diagnostics_pane_running_sentence", {
								value: processes?.processes.length ?? 0,
							})}
						</p>
					</FrameHeader>
					<FramePanel className="overflow-hidden p-0">
						{processes && !processes.supported && (
							<div className="flex items-center gap-2 border-b border-border/45 bg-warning/8 px-4 py-2.5 text-[10px] text-warning">
								<AlertTriangle className="size-3.5" />
								{processes.error ??
									uiMessage(
										"settings:diagnostics_pane_process_sampling_is_not_supported_on_this_platform",
									)}
							</div>
						)}
						<div className="overflow-x-auto">
							<table className="w-full min-w-[780px] text-left text-[10px]">
								<thead className="border-b border-border/45 text-[9px] text-muted-foreground uppercase tracking-wider">
									<tr>
										<th className="px-4 py-2">
											{uiMessage("settings:diagnostics_pane_process")}
										</th>
										<th className="px-3 py-2 text-right">
											{uiMessage("settings:diagnostics_pane_cpu")}
										</th>
										<th className="px-3 py-2 text-right">
											{uiMessage("settings:diagnostics_pane_memory")}
										</th>
										<th className="px-3 py-2">
											{uiMessage("settings:diagnostics_pane_command")}
										</th>
										<th className="px-3 py-2 text-right">
											{uiMessage("settings:diagnostics_pane_pid")}
										</th>
										<th className="px-4 py-2 text-right">
											{uiMessage("settings:diagnostics_pane_actions")}
										</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-border/40">
									{processes?.processes.map((item) => (
										<tr key={item.pid} className="hover:bg-muted/20">
											<td
												className="px-4 py-2.5 font-medium"
												style={{
													paddingLeft: `${16 + Math.min(item.depth, 6) * 14}px`,
												}}
											>
												{item.name}
											</td>
											<td className="px-3 py-2.5 text-right font-mono tabular-nums">
												{item.cpuPercent.toFixed(1)}%
											</td>
											<td className="px-3 py-2.5 text-right font-mono tabular-nums">
												{formatBytes(item.rssBytes)}
											</td>
											<td
												className="max-w-72 truncate px-3 py-2.5 text-muted-foreground"
												title={item.command}
											>
												{item.command}
											</td>
											<td className="px-3 py-2.5 text-right font-mono tabular-nums">
												{item.pid}
											</td>
											<td className="px-4 py-2">
												<div className="flex justify-end gap-1">
													<Button
														size="sm"
														variant="ghost"
														className="h-7 min-w-16 !text-[9px]"
														disabled={item.pid === processes.serverPid}
														onClick={() =>
															void signalProcess(item.pid, "interrupt")
														}
													>
														{uiMessage("settings:diagnostics_pane_interrupt")}
													</Button>
													<Button
														size="sm"
														variant="destructive-outline"
														className="h-7 min-w-16 !text-[9px]"
														disabled={item.pid === processes.serverPid}
														onClick={() => void signalProcess(item.pid, "kill")}
													>
														{uiMessage("settings:diagnostics_pane_kill")}
													</Button>
												</div>
											</td>
										</tr>
									))}
								</tbody>
							</table>
							{!loading && !processes?.processes.length && (
								<EmptyState
									icon={Server}
									title={uiMessage(
										"settings:diagnostics_pane_no_helper_processes",
									)}
									description={
										processes?.error ??
										uiMessage(
											"settings:diagnostics_pane_no_live_descendants_are_owned_by_the_diagnostics_root",
										)
									}
								/>
							)}
						</div>
					</FramePanel>
				</Frame>
			)}

			{view === "storage" && (
				<Frame
					aria-label={uiMessage(
						"settings:diagnostics_pane_diagnostics_storage_and_privacy",
					)}
				>
					<FrameHeader className="px-3 py-2.5">
						<FrameTitle className="text-[12px]">
							{uiMessage("settings:diagnostics_pane_storage_and_privacy")}
						</FrameTitle>
						<FrameDescription className="text-[9px] leading-3.5">
							{uiMessage(
								"settings:diagnostics_pane_diagnostics_stay_on_this_device_unless_you_explicitly_export_them",
							)}
						</FrameDescription>
					</FrameHeader>
					<FramePanel className="overflow-hidden p-0">
						<div className="grid divide-y divide-border/45 md:grid-cols-3 md:divide-x md:divide-y-0">
							<div className="p-4">
								<p className="font-medium text-[10px]">
									{uiMessage("settings:diagnostics_pane_retention")}
								</p>
								<p className="mt-1 font-mono text-sm tabular-nums">
									{uiMessage("settings:diagnostics_pane_7_days")}
								</p>
								<p className="mt-1 text-[9px] text-muted-foreground">
									{uiMessage(
										"settings:diagnostics_pane_incidents_and_five_minute_operation_rollups_are_pruned_by_age",
									)}
								</p>
							</div>
							<div className="p-4">
								<p className="font-medium text-[10px]">
									{uiMessage("settings:diagnostics_pane_local_usage")}
								</p>
								<p className="mt-1 font-mono text-sm tabular-nums">
									{formatBytes(
										(overview?.storageBytes ?? 0) +
											(performanceHistory?.storageBytes ?? 0),
									)}
								</p>
								<p className="mt-1 text-[9px] text-muted-foreground">
									{uiMessage(
										"settings:diagnostics_pane_includes_events_and_performance_history_on_this_device",
									)}
								</p>
							</div>
							<div className="min-h-[128px] p-4">
								<div className="flex items-start justify-between gap-3">
									<div>
										<p className="font-medium text-[10px]">
											{uiMessage("settings:diagnostics_pane_incident_capture")}
										</p>
										<p className="mt-1 text-sm" aria-live="polite">
											{overview?.captureMode === "full"
												? uiMessage(
														"settings:diagnostics_pane_full_trace_active",
													)
												: uiMessage("settings:diagnostics_pane_on")}
										</p>
									</div>
									{overview?.captureMode === "full" &&
										overview.fullCaptureEndsAt && (
											<span
												className="font-mono text-[10px] text-warning tabular-nums"
												role="timer"
												aria-label={uiMessage(
													"settings:diagnostics_pane_full_trace_time_remaining",
												)}
											>
												{formatCaptureCountdown(
													overview.fullCaptureEndsAt,
													captureNow,
												)}
											</span>
										)}
								</div>
								<div className="mt-3 flex items-center gap-2">
									<Select
										value={String(captureDuration)}
										disabled={captureBusy || overview?.captureMode === "full"}
										onValueChange={(value) =>
											setCaptureDuration(
												Number(value) as DiagnosticsCaptureDuration,
											)
										}
									>
										<SelectTrigger
											size="sm"
											className="w-[78px] min-w-0"
											aria-label={uiMessage(
												"settings:diagnostics_pane_full_trace_duration",
											)}
										>
											<SelectValue />
										</SelectTrigger>
										<SelectPopup>
											<SelectItem value="5">
												{uiMessage("settings:diagnostics_pane_5_min")}
											</SelectItem>
											<SelectItem value="15">
												{uiMessage("settings:diagnostics_pane_15_min")}
											</SelectItem>
											<SelectItem value="30">
												{uiMessage("settings:diagnostics_pane_30_min")}
											</SelectItem>
										</SelectPopup>
									</Select>
									<Button
										size="sm"
										variant={
											overview?.captureMode === "full" ? "settings" : "default"
										}
										className="h-7 min-w-[104px] px-2.5 !text-[10px]"
										loading={captureBusy}
										disabled={overview === null || captureBusy}
										onClick={() => void updateCapture()}
									>
										{overview?.captureMode === "full"
											? uiMessage("settings:diagnostics_pane_stop_full_trace")
											: uiMessage("settings:diagnostics_pane_start_full_trace")}
									</Button>
								</div>
								<p className="mt-2 text-[9px] text-muted-foreground">
									{uiMessage(
										"settings:diagnostics_pane_dropped_secrets_and_conversation_content_excluded_sentence",
										{
											value: formatCount.format(
												overview?.droppedEventCount ?? 0,
											),
										},
									)}
								</p>
							</div>
						</div>
						<div className="border-t border-border/45 p-4">
							<div className="max-w-2xl">
								<h3 className="font-medium text-[11px]">
									{uiMessage("settings:diagnostics_pane_support_bundle")}
								</h3>
								<p className="mt-1 text-[10px] text-muted-foreground leading-4">
									{uiMessage(
										"settings:diagnostics_pane_creates_a_sanitized_local_bundle_for_the_selected_time_range_prompts_t",
									)}
								</p>
							</div>
							<div className="mt-4 flex flex-wrap gap-2">
								<Button
									size="sm"
									className="h-7 gap-1.5 px-2.5 !text-[10px] [&_svg]:size-3.5"
									loading={exporting}
									onClick={() => void exportBundle()}
								>
									<Archive />
									{uiMessage("settings:diagnostics_pane_export_support_bundle")}
								</Button>
								<Button
									size="sm"
									variant="settings"
									className="h-7 gap-1.5 px-2.5 !text-[10px] [&_svg]:size-3.5"
									onClick={() =>
										void (
											window.zuse ?? window.memoize
										)?.app?.revealDiagnosticsLogs?.()
									}
								>
									<ExternalLink />
									{uiMessage(
										"settings:diagnostics_pane_open_diagnostics_folder",
									)}
								</Button>
								<Button
									size="sm"
									variant="settings"
									className="h-7 gap-1.5 px-2.5 !text-[10px]"
									onClick={() => void clearPerformanceHistory()}
								>
									{uiMessage(
										"settings:diagnostics_pane_clear_performance_history",
									)}
								</Button>
							</div>
						</div>
					</FramePanel>
				</Frame>
			)}

			<Dialog
				open={isNarrow && mobileDetailsOpen}
				onOpenChange={setMobileDetailsOpen}
			>
				<DialogPopup className="max-w-lg">
					<DialogHeader>
						<DialogTitle className="text-base">
							{uiMessage("settings:diagnostics_pane_issue_details")}
						</DialogTitle>
						<DialogDescription className="text-[10px]">
							{uiMessage(
								"settings:diagnostics_pane_sanitized_diagnostic_context_and_related_occurrences",
							)}
						</DialogDescription>
					</DialogHeader>
					<DialogPanel className="p-0" scrollFade={false}>
						<IncidentDetails
							selected={selected}
							related={related}
							copiedKey={copiedKey}
							onCopy={copyText}
						/>
					</DialogPanel>
				</DialogPopup>
			</Dialog>
		</div>
	);
}
