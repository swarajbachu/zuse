import type {
	DiagnosticEvent,
	DiagnosticSeverity,
	DiagnosticsOverviewResult,
	DiagnosticsProcessesResult,
} from "@zuse/contracts";
import { Effect } from "effect";
import {
	Activity,
	AlertTriangle,
	Archive,
	Check,
	Copy,
	ExternalLink,
	FolderOpen,
	Gauge,
	HardDrive,
	ListTodo,
	Pause,
	Play,
	RefreshCw,
	Search,
	Server,
	ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useMediaQuery } from "../../hooks/use-media-query.ts";
import { collectDiagnosticsClientContext } from "../../lib/diagnostics-client-context.ts";
import { flushRendererDiagnostics } from "../../lib/diagnostics-recorder.ts";
import {
	DEFAULT_DIAGNOSTICS_PREFERENCES,
	DIAGNOSTICS_PREFERENCES_KEY,
	DIAGNOSTICS_RANGE_OPTIONS,
	type DiagnosticsPreferences,
	type DiagnosticsSeverityFilter,
	type DiagnosticsView,
	groupDiagnosticEvents,
	parseDiagnosticsPreferences,
	relatedDiagnosticEvents,
} from "../../lib/diagnostics-view-model.ts";
import { getRpcClient } from "../../lib/rpc-client.ts";
import { cn } from "../../lib/utils.ts";
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

const VIEW_OPTIONS: ReadonlyArray<{
	readonly id: DiagnosticsView;
	readonly label: string;
	readonly icon: typeof ListTodo;
}> = [
	{ id: "issues", label: "Issues", icon: ListTodo },
	{ id: "performance", label: "Performance", icon: Gauge },
	{ id: "processes", label: "Processes", icon: Server },
	{ id: "storage", label: "Storage", icon: HardDrive },
];

const formatCount = new Intl.NumberFormat();
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

function Sparkline({
	values,
	className,
	label,
}: {
	readonly values: ReadonlyArray<number>;
	readonly className?: string;
	readonly label: string;
}) {
	const width = 112;
	const height = 30;
	const chartValues =
		values.length === 0
			? [0, 0]
			: values.length === 1
				? [values[0] ?? 0, values[0] ?? 0]
				: values;
	const peak = Math.max(1, ...chartValues);
	const points = chartValues
		.map((value, index) => {
			const x = (index / Math.max(1, chartValues.length - 1)) * width;
			const y = height - Math.min(1, value / peak) * (height - 4) - 2;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");

	return (
		<svg
			viewBox={`0 0 ${width} ${height}`}
			preserveAspectRatio="none"
			className={cn("h-[30px] w-28", className)}
			role="img"
			aria-label={label}
		>
			<polyline
				points={points}
				fill="none"
				vectorEffect="non-scaling-stroke"
				strokeWidth="1.5"
				className="stroke-current"
			/>
		</svg>
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
				<Sparkline
					values={values}
					label={`${label} live trend`}
					className={cn(
						"shrink-0 text-muted-foreground/65",
						tone === "danger" && "text-destructive/70",
						tone === "warning" && "text-warning/70",
					)}
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
	className,
}: {
	readonly label: string;
	readonly value: number;
	readonly peak: number;
	readonly values: ReadonlyArray<number>;
	readonly formatValue: (value: number) => string;
	readonly className: string;
}) {
	const width = 420;
	const height = 116;
	const ceiling = Math.max(1, peak);
	const chartValues =
		values.length === 0
			? [0, 0]
			: values.length === 1
				? [values[0] ?? 0, values[0] ?? 0]
				: values;
	const points = chartValues.map((sample, index, all) => {
		const x = (index / Math.max(1, all.length - 1)) * width;
		const y = height - Math.min(1, sample / ceiling) * (height - 10) - 5;
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	});

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
					Peak <span className="font-mono">{formatValue(peak)}</span>
				</p>
			</div>
			<svg
				viewBox={`0 0 ${width} ${height}`}
				preserveAspectRatio="none"
				className="mt-3 block h-28 w-full"
				role="img"
				aria-label={`${label}: ${formatValue(value)}, peak ${formatValue(peak)}`}
			>
				<line x1="0" x2={width} y1="38" y2="38" className="stroke-border/45" />
				<line x1="0" x2={width} y1="77" y2="77" className="stroke-border/45" />
				<polyline
					points={points.join(" ")}
					fill="none"
					vectorEffect="non-scaling-stroke"
					strokeWidth="1.5"
					className={className}
				/>
			</svg>
			<p className="text-[9px] text-muted-foreground">
				Live samples from this page session
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
	const copied = copiedKey === copyKey;
	return (
		<Button
			size="sm"
			variant="settings"
			className="h-7 gap-1.5 px-2.5 !text-[10px] [&_svg]:size-3.5"
			onClick={() => onCopy(copyKey, text)}
		>
			{copied ? <Check /> : <Copy />}
			{copied ? "Copied" : label}
		</Button>
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
	if (!selected) {
		return (
			<EmptyState
				title="Select an issue"
				description="Its sanitized details, related occurrences, and correlation IDs will appear here."
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
								? "Diagnostic ID copied"
								: "Copy diagnostic ID"
						}
						onClick={() => onCopy("diagnostic-id", selected.id)}
					>
						{copiedKey === "diagnostic-id" ? <Check /> : <Copy />}
					</Button>
				</div>
			</div>

			<div className="space-y-4 p-4">
				<dl className="grid grid-cols-[82px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[10px]">
					<dt className="text-muted-foreground">Diagnostic ID</dt>
					<dd className="truncate font-mono" title={selected.id}>
						{selected.id}
					</dd>
					<dt className="text-muted-foreground">Run</dt>
					<dd className="truncate font-mono">{selected.runId}</dd>
					<dt className="text-muted-foreground">Recovery</dt>
					<dd className="capitalize">{selected.recoveryStatus}</dd>
					<dt className="text-muted-foreground">Trace</dt>
					<dd className="truncate font-mono">
						{selected.traceId ?? "Not correlated"}
					</dd>
					<dt className="text-muted-foreground">Session</dt>
					<dd className="truncate font-mono">
						{selected.sessionId ?? selected.chatId ?? "Not correlated"}
					</dd>
					<dt className="text-muted-foreground">Provider</dt>
					<dd className="truncate font-mono">
						{selected.providerId ?? "Not correlated"}
					</dd>
				</dl>

				{selected.detail ? (
					<div>
						<p className="mb-1.5 font-medium text-[10px]">Sanitized details</p>
						<pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-[9px] leading-4">
							{selected.detail}
						</pre>
					</div>
				) : (
					<p className="rounded-md bg-muted/35 px-3 py-2 text-[10px] text-muted-foreground">
						No additional stack or cause was captured.
					</p>
				)}

				<div>
					<div className="mb-1.5 flex items-center justify-between">
						<p className="font-medium text-[10px]">Related occurrences</p>
						<span className="font-mono text-[9px] text-muted-foreground tabular-nums">
							{related.length} loaded
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
					label="Copy details"
					text={`${selected.id}\n${selected.message}\n${selected.detail ?? ""}`}
				/>
			</div>
		</div>
	);
}

export function DiagnosticsPane() {
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
	const [selected, setSelected] = useState<DiagnosticEvent | null>(null);
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

	const refresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await flushRendererDiagnostics();
			const client = await getRpcClient();
			if (!mainLogsIngestedRef.current) {
				try {
					const mainLogs =
						(await window.zuse?.app?.getMainDiagnostics?.().catch(() => [])) ??
						[];
					const unpublishedMainLogs = mainLogs.filter(
						(log) => log.source !== "main.previousRunUnclean",
					);
					if (unpublishedMainLogs.length > 0) {
						await Effect.runPromise(
							client["diagnostics.ingest"]({
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
							}),
						);
					}
					mainLogsIngestedRef.current = true;
				} catch {
					// Main-process ingestion is best effort and must not block inspection.
				}
			}

			const since = new Date(Date.now() - rangeMs).toISOString();
			const [overviewResult, eventsResult, processesResult] =
				await Promise.allSettled([
					Effect.runPromise(client["diagnostics.overview"]({ since })),
					Effect.runPromise(
						client["diagnostics.events"]({
							limit: 200,
							since,
							...(severity === "all" ? {} : { severities: [severity] }),
							...(querySource ? { source: querySource } : {}),
							...(querySearch ? { search: querySearch } : {}),
						}),
					),
					Effect.runPromise(client["diagnostics.processes"]()),
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
	}, [querySearch, querySource, rangeMs, severity]);

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
			const client = await getRpcClient();
			const page = await Effect.runPromise(
				client["diagnostics.events"]({
					cursor: nextEventCursor,
					limit: 200,
					since: new Date(Date.now() - rangeMs).toISOString(),
					...(severity === "all" ? {} : { severities: [severity] }),
					...(querySource ? { source: querySource } : {}),
					...(querySearch ? { search: querySearch } : {}),
				}),
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
			const client = await getRpcClient();
			const clientContext = await collectDiagnosticsClientContext();
			const result = await Effect.runPromise(
				client["diagnostics.export"]({
					clientContext,
					since: new Date(Date.now() - rangeMs).toISOString(),
					includeSessionEvents: false,
				}),
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
			const client = await getRpcClient();
			const result = await Effect.runPromise(
				client["diagnostics.signalProcess"]({ pid, signal }),
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
		[overview],
	);
	const incidents = useMemo(
		() => groupDiagnosticEvents(events, commonCounts),
		[commonCounts, events],
	);
	const related = useMemo(
		() =>
			selected ? relatedDiagnosticEvents(events, selected.fingerprint) : [],
		[events, selected],
	);
	const maxCpu = Math.max(1, ...samples.map((sample) => sample.cpu));
	const maxMemory = Math.max(1, ...samples.map((sample) => sample.memory));
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
			<Frame aria-label="Diagnostics status">
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
									? `${overview.unseenCount} unseen · ${live ? "Live capture" : "Updates paused"} · ${relativeTime(overview.readAt)}`
									: "Reading local diagnostics…"}
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
							{live ? "Pause live" : "Resume live"}
						</Button>
						<Button
							size="sm"
							variant="settings"
							className="h-7 min-w-24 gap-1.5 px-2.5 !text-[10px] [&_svg]:size-3.5"
							loading={refreshing}
							onClick={() => void refresh()}
						>
							<RefreshCw />
							Refresh
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
							Open logs
						</Button>
						<Button
							size="sm"
							className="h-7 gap-1.5 px-2.5 !text-[10px] [&_svg]:size-3.5"
							loading={exporting}
							onClick={() => void exportBundle()}
						>
							<Archive />
							Export support bundle
						</Button>
					</div>
				</FrameHeader>
				<FramePanel className="grid min-h-[68px] grid-cols-2 divide-x divide-y divide-border/45 p-0 lg:grid-cols-5 lg:divide-y-0">
					<PulseMetric
						label="Failures"
						value={overview ? formatCount.format(failureCount) : "—"}
						tone={failureCount > 0 ? "danger" : "default"}
						values={samples.map((sample) => sample.failures)}
					/>
					<PulseMetric
						label="Warnings"
						value={overview ? formatCount.format(overview.warningCount) : "—"}
						tone={(overview?.warningCount ?? 0) > 0 ? "warning" : "default"}
					/>
					<PulseMetric
						label="CPU"
						value={processes ? `${processes.totalCpuPercent.toFixed(1)}%` : "—"}
						values={samples.map((sample) => sample.cpu)}
					/>
					<PulseMetric
						label="Memory"
						value={processes ? formatBytes(processes.totalRssBytes) : "—"}
						values={samples.map((sample) => sample.memory)}
					/>
					<PulseMetric
						label="Stored locally"
						value={overview ? formatBytes(overview.storageBytes) : "—"}
					/>
				</FramePanel>
			</Frame>

			{error && (
				<div
					role="alert"
					className="flex min-h-10 items-start gap-2 rounded-lg bg-alert-error-bg px-3 py-2 text-[10px] text-destructive-foreground"
				>
					<AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
					<span className="flex-1">{error}</span>
					<Button
						size="xs"
						variant="ghost"
						className="h-6 !text-[9px]"
						onClick={() => void refresh()}
					>
						Retry
					</Button>
				</div>
			)}

			<nav
				aria-label="Diagnostics views"
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
				<Frame aria-label="Issue triage workspace">
					<FrameHeader className="flex w-full flex-row flex-wrap items-center justify-between gap-3 px-3 py-2.5">
						<div>
							<FrameTitle className="text-[12px]">Issue inbox</FrameTitle>
							<FrameDescription className="text-[9px] leading-3.5">
								Repeated failures are grouped so the most important work stays
								visible.
							</FrameDescription>
						</div>
						<p className="font-mono text-[9px] text-muted-foreground tabular-nums">
							{formatCount.format(incidents.length)} groups ·{" "}
							{formatCount.format(eventTotal)} events
						</p>
					</FrameHeader>
					<FramePanel className="overflow-hidden p-0">
						<div className="flex flex-wrap items-center gap-2 border-b border-border/45 p-2.5">
							<label className="relative min-w-48 flex-1">
								<span className="sr-only">Search diagnostic issues</span>
								<Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
								<input
									type="search"
									value={search}
									onChange={(event) => setSearch(event.target.value)}
									className="h-8 w-full rounded-md border border-border/50 bg-background pl-8 pr-2 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:text-base"
									placeholder="Search messages and details"
									spellCheck={false}
								/>
							</label>
							<label>
								<span className="sr-only">Filter by severity</span>
								<select
									value={severity}
									onChange={(event) =>
										setSeverity(event.target.value as DiagnosticsSeverityFilter)
									}
									className="h-8 rounded-md border border-border/50 bg-background px-2 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:text-base"
								>
									<option value="all">All levels</option>
									<option value="fatal">Fatal</option>
									<option value="error">Errors</option>
									<option value="warn">Warnings</option>
									<option value="info">Info</option>
								</select>
							</label>
							<label className="min-w-36 flex-1 sm:max-w-48">
								<span className="sr-only">Filter by source</span>
								<input
									value={source}
									onChange={(event) => setSource(event.target.value)}
									className="h-8 w-full rounded-md border border-border/50 bg-background px-2 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:text-base"
									placeholder="All sources"
									spellCheck={false}
								/>
							</label>
							<div className="flex rounded-md border border-border/50 bg-background p-0.5">
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
						</div>

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
															? ` · session ${item.sessionId}`
															: ""}
													</span>
												</span>
												<span className="text-right">
													<span className="block font-mono text-[10px] tabular-nums">
														{incident.occurrences > 1
															? `${incident.occurrences}×`
															: "Once"}
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
											title="No matching issues"
											description="Change the filters or time range. Healthy captures will appear here only when they need attention."
										/>
									)}
									{loading && incidents.length === 0 && (
										<EmptyState
											icon={Activity}
											title="Checking the system"
											description="Reading recent incidents and correlating local process state."
										/>
									)}
								</div>
								{nextEventCursor && (
									<div className="flex min-h-11 items-center justify-between border-t border-border/45 px-4 py-2 text-[9px] text-muted-foreground">
										<span className="font-mono tabular-nums">
											{formatCount.format(events.length)} of{" "}
											{formatCount.format(eventTotal)} events loaded
										</span>
										<Button
											size="sm"
											variant="settings"
											className="h-7 px-2.5 !text-[10px]"
											onClick={() => void loadMoreEvents()}
										>
											Load more
										</Button>
									</div>
								)}
							</div>
							<aside
								className="hidden min-w-0 xl:block"
								aria-label="Issue details"
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

			{view === "performance" && (
				<Frame aria-label="Performance diagnostics">
					<FrameHeader className="flex w-full flex-row flex-wrap items-center justify-between gap-3 px-3 py-2.5">
						<div>
							<FrameTitle className="text-[12px]">Performance</FrameTitle>
							<FrameDescription className="text-[9px] leading-3.5">
								Live resource pressure and the operations most likely to slow
								the app down.
							</FrameDescription>
						</div>
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
					</FrameHeader>
					<FramePanel className="overflow-hidden p-0">
						<div className="grid grid-cols-2 divide-x divide-y divide-border/45 lg:grid-cols-4 lg:divide-y-0">
							<PulseMetric
								label="Captured events"
								value={formatCount.format(overview?.eventCount ?? 0)}
							/>
							<PulseMetric
								label="Slow spans"
								value={formatCount.format(overview?.slowOperationCount ?? 0)}
							/>
							<PulseMetric
								label="Parse errors"
								value={formatCount.format(overview?.parseErrorCount ?? 0)}
								tone={
									(overview?.parseErrorCount ?? 0) > 0 ? "warning" : "default"
								}
							/>
							<PulseMetric
								label="Trace state"
								value={
									(overview?.parseErrorCount ?? 0) > 0 ? "Partial" : "Ready"
								}
							/>
						</div>
						<div className="grid divide-y divide-border/45 border-t border-border/45 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
							<ResourceChart
								label="CPU usage"
								value={processes?.totalCpuPercent ?? 0}
								peak={maxCpu}
								values={samples.map((sample) => sample.cpu)}
								formatValue={(value) => `${value.toFixed(1)}%`}
								className="stroke-foreground"
							/>
							<ResourceChart
								label="Memory usage"
								value={processes?.totalRssBytes ?? 0}
								peak={maxMemory}
								values={samples.map((sample) => sample.memory)}
								formatValue={formatBytes}
								className="stroke-warning"
							/>
						</div>
						<div className="grid border-t border-border/45 lg:grid-cols-2 lg:divide-x lg:divide-border/45">
							<section className="min-w-0">
								<div className="border-b border-border/45 px-4 py-2.5">
									<h3 className="font-medium text-[10px]">
										Slowest operations
									</h3>
								</div>
								{overview?.slowestOperations.length ? (
									<div className="divide-y divide-border/40">
										{overview.slowestOperations.slice(0, 8).map((item) => (
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
												<span className="shrink-0 font-mono text-[10px] tabular-nums">
													{formatDuration(item.durationMs ?? 0)}
												</span>
											</div>
										))}
									</div>
								) : (
									<EmptyState
										title="No slow operations"
										description="Operations taking at least one second will appear here."
									/>
								)}
							</section>
							<section className="min-w-0 border-t border-border/45 lg:border-t-0">
								<div className="border-b border-border/45 px-4 py-2.5">
									<h3 className="font-medium text-[10px]">Top operations</h3>
								</div>
								{overview?.topOperations.length ? (
									<div className="divide-y divide-border/40">
										{overview.topOperations.slice(0, 8).map((item) => (
											<div
												key={item.name}
												className="grid grid-cols-[minmax(0,1fr)_repeat(5,48px)] gap-2 px-4 py-3 text-[9px]"
											>
												<span className="truncate font-medium text-[10px]">
													{item.name}
												</span>
												<span
													className="text-right font-mono tabular-nums"
													title="Count"
												>
													{item.count}×
												</span>
												<span
													className="text-right font-mono tabular-nums"
													title="Failures"
												>
													{item.failureCount} fail
												</span>
												<span
													className="text-right font-mono tabular-nums"
													title="Average"
												>
													{formatDuration(item.averageDurationMs)}
												</span>
												<span
													className="text-right font-mono tabular-nums"
													title="95th percentile"
												>
													{formatDuration(item.p95DurationMs)}
												</span>
												<span
													className="text-right font-mono tabular-nums"
													title="Maximum"
												>
													{formatDuration(item.maxDurationMs)}
												</span>
											</div>
										))}
									</div>
								) : (
									<EmptyState
										title="No operation summaries"
										description="Instrumented traces will build an operation profile here."
									/>
								)}
							</section>
						</div>
					</FramePanel>
				</Frame>
			)}

			{view === "processes" && (
				<Frame aria-label="Live processes">
					<FrameHeader className="flex w-full flex-row items-center justify-between gap-3 px-3 py-2.5">
						<div>
							<FrameTitle className="text-[12px]">Live processes</FrameTitle>
							<FrameDescription className="text-[9px] leading-3.5">
								Server-owned helpers. Process ancestry is validated again before
								every signal.
							</FrameDescription>
						</div>
						<p className="shrink-0 font-mono text-[9px] text-muted-foreground tabular-nums">
							{processes?.processes.length ?? 0} running
						</p>
					</FrameHeader>
					<FramePanel className="overflow-hidden p-0">
						{processes && !processes.supported && (
							<div className="flex items-center gap-2 border-b border-border/45 bg-warning/8 px-4 py-2.5 text-[10px] text-warning">
								<AlertTriangle className="size-3.5" />
								{processes.error ??
									"Process sampling is not supported on this platform."}
							</div>
						)}
						<div className="overflow-x-auto">
							<table className="w-full min-w-[780px] text-left text-[10px]">
								<thead className="border-b border-border/45 text-[9px] text-muted-foreground uppercase tracking-wider">
									<tr>
										<th className="px-4 py-2">Process</th>
										<th className="px-3 py-2 text-right">CPU</th>
										<th className="px-3 py-2 text-right">Memory</th>
										<th className="px-3 py-2">Command</th>
										<th className="px-3 py-2 text-right">PID</th>
										<th className="px-4 py-2 text-right">Actions</th>
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
														Interrupt
													</Button>
													<Button
														size="sm"
														variant="destructive-outline"
														className="h-7 min-w-16 !text-[9px]"
														disabled={item.pid === processes.serverPid}
														onClick={() => void signalProcess(item.pid, "kill")}
													>
														Kill
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
									title="No helper processes"
									description={
										processes?.error ??
										"No live descendants are owned by the diagnostics root."
									}
								/>
							)}
						</div>
					</FramePanel>
				</Frame>
			)}

			{view === "storage" && (
				<Frame aria-label="Diagnostics storage and privacy">
					<FrameHeader className="px-3 py-2.5">
						<FrameTitle className="text-[12px]">Storage and privacy</FrameTitle>
						<FrameDescription className="text-[9px] leading-3.5">
							Diagnostics stay on this device unless you explicitly export them.
						</FrameDescription>
					</FrameHeader>
					<FramePanel className="overflow-hidden p-0">
						<div className="grid divide-y divide-border/45 md:grid-cols-3 md:divide-x md:divide-y-0">
							<div className="p-4">
								<p className="font-medium text-[10px]">Retention</p>
								<p className="mt-1 font-mono text-sm tabular-nums">7 days</p>
								<p className="mt-1 text-[9px] text-muted-foreground">
									250 MB maximum across rotating diagnostic files.
								</p>
							</div>
							<div className="p-4">
								<p className="font-medium text-[10px]">Local usage</p>
								<p className="mt-1 font-mono text-sm tabular-nums">
									{formatBytes(overview?.storageBytes ?? 0)}
								</p>
								<p className="mt-1 text-[9px] text-muted-foreground">
									Old files are pruned by age and storage budget.
								</p>
							</div>
							<div className="p-4">
								<p className="font-medium text-[10px]">Capture</p>
								<p className="mt-1 text-sm">
									{overview?.capturePaused ? "Paused" : "Standard"}
								</p>
								<p className="mt-1 text-[9px] text-muted-foreground">
									Secrets and conversation content are excluded by default.
								</p>
							</div>
						</div>
						<div className="border-t border-border/45 p-4">
							<div className="max-w-2xl">
								<h3 className="font-medium text-[11px]">Support bundle</h3>
								<p className="mt-1 text-[10px] text-muted-foreground leading-4">
									Creates a sanitized local bundle for the selected time range.
									Prompts, transcripts, files, terminal output, credentials,
									environment values, and URL query strings remain excluded.
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
									Export support bundle
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
									Open diagnostics folder
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
						<DialogTitle className="text-base">Issue details</DialogTitle>
						<DialogDescription className="text-[10px]">
							Sanitized diagnostic context and related occurrences.
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
