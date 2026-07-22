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
	Copy,
	ExternalLink,
	FolderOpen,
	Pause,
	Play,
	RefreshCw,
	Search,
	Server,
	ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { collectDiagnosticsClientContext } from "../../lib/diagnostics-client-context.ts";
import { flushRendererDiagnostics } from "../../lib/diagnostics-recorder.ts";
import { getRpcClient } from "../../lib/rpc-client.ts";
import { cn } from "../../lib/utils.ts";
import { Button } from "../ui/button.tsx";

const RANGE_OPTIONS = [
	{ label: "15m", milliseconds: 15 * 60_000 },
	{ label: "1h", milliseconds: 60 * 60_000 },
	{ label: "24h", milliseconds: 24 * 60 * 60_000 },
	{ label: "7d", milliseconds: 7 * 24 * 60 * 60_000 },
] as const;

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

function DiagnosticsSection({
	title,
	description,
	action,
	children,
}: {
	readonly title: string;
	readonly description?: string;
	readonly action?: React.ReactNode;
	readonly children: React.ReactNode;
}) {
	return (
		<section className="overflow-hidden rounded-xl border border-border/50 bg-card/70 shadow-xs">
			<header className="flex min-h-14 items-center justify-between gap-4 border-b border-border/45 px-4 py-3">
				<div className="min-w-0">
					<h2 className="font-semibold text-sm text-foreground">{title}</h2>
					{description && (
						<p className="mt-0.5 text-muted-foreground text-xs">
							{description}
						</p>
					)}
				</div>
				{action}
			</header>
			{children}
		</section>
	);
}

function Stat({
	label,
	value,
	tone = "default",
}: {
	label: string;
	value: string;
	tone?: "default" | "warning" | "danger";
}) {
	return (
		<div className="min-w-0 px-4 py-3">
			<p className="truncate font-medium text-[10px] text-muted-foreground uppercase tracking-[0.1em]">
				{label}
			</p>
			<p
				className={cn(
					"mt-1 truncate font-mono font-semibold text-lg tabular-nums",
					tone === "danger" && "text-destructive",
					tone === "warning" && "text-warning",
				)}
			>
				{value}
			</p>
		</div>
	);
}

function Empty({ children }: { children: React.ReactNode }) {
	return (
		<div className="px-4 py-6 text-center text-muted-foreground text-xs">
			{children}
		</div>
	);
}

function SeverityPill({ severity }: { severity: DiagnosticSeverity }) {
	return (
		<span
			className={cn(
				"inline-flex rounded-md px-1.5 py-0.5 font-medium text-[10px] uppercase",
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

export function DiagnosticsPane() {
	const mainLogsIngestedRef = useRef(false);
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
	const [live, setLive] = useState(true);
	const [loading, setLoading] = useState(true);
	const [exporting, setExporting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [severity, setSeverity] = useState<DiagnosticSeverity | "all">("all");
	const [source, setSource] = useState("");
	const [rangeMs, setRangeMs] = useState(RANGE_OPTIONS[2].milliseconds);
	const [samples, setSamples] = useState<
		ReadonlyArray<{ at: string; cpu: number; memory: number }>
	>([]);

	const since = useMemo(
		() => new Date(Date.now() - rangeMs).toISOString(),
		[rangeMs],
	);
	const refresh = useCallback(async () => {
		try {
			await flushRendererDiagnostics();
			const client = await getRpcClient();
			if (!mainLogsIngestedRef.current) {
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
			}
			const [nextOverview, nextEvents, nextProcesses] = await Promise.all([
				Effect.runPromise(client["diagnostics.overview"]({ since })),
				Effect.runPromise(
					client["diagnostics.events"]({
						limit: 200,
						since,
						...(severity === "all" ? {} : { severities: [severity] }),
						...(source.trim() ? { source: source.trim() } : {}),
						...(search.trim() ? { search: search.trim() } : {}),
					}),
				),
				Effect.runPromise(client["diagnostics.processes"]()),
			]);
			setOverview(nextOverview);
			setEvents(nextEvents.events);
			setNextEventCursor(nextEvents.nextCursor);
			setEventTotal(nextEvents.total);
			setProcesses(nextProcesses);
			setSamples((current) =>
				[
					...current,
					{
						at: nextProcesses.readAt,
						cpu: nextProcesses.totalCpuPercent,
						memory: nextProcesses.totalRssBytes,
					},
				].slice(-720),
			);
			setError(null);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Diagnostics could not be refreshed.",
			);
		} finally {
			setLoading(false);
		}
	}, [search, severity, since, source]);
	const loadMoreEvents = async () => {
		if (!nextEventCursor) return;
		try {
			const client = await getRpcClient();
			const page = await Effect.runPromise(
				client["diagnostics.events"]({
					cursor: nextEventCursor,
					limit: 200,
					since,
					...(severity === "all" ? {} : { severities: [severity] }),
					...(source.trim() ? { source: source.trim() } : {}),
					...(search.trim() ? { search: search.trim() } : {}),
				}),
			);
			setEvents((current) => [...current, ...page.events]);
			setNextEventCursor(page.nextCursor);
			setEventTotal(page.total);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "More events could not be loaded.",
			);
		}
	};

	useEffect(() => {
		void refresh();
	}, [refresh]);
	useEffect(() => {
		if (!live) return;
		const timer = window.setInterval(() => void refresh(), 5_000);
		return () => window.clearInterval(timer);
	}, [live, refresh]);

	const exportBundle = async () => {
		setExporting(true);
		try {
			const client = await getRpcClient();
			const clientContext = await collectDiagnosticsClientContext();
			const result = await Effect.runPromise(
				client["diagnostics.export"]({
					clientContext,
					since,
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
		const client = await getRpcClient();
		const result = await Effect.runPromise(
			client["diagnostics.signalProcess"]({ pid, signal }),
		);
		if (!result.signaled)
			setError(result.message ?? "The process could not be signaled.");
		await refresh();
	};

	const maxCpu = Math.max(1, ...samples.map((sample) => sample.cpu));
	const statusTone =
		overview?.status === "failing"
			? "text-destructive"
			: overview?.status === "degraded"
				? "text-warning"
				: "text-success";

	return (
		<div className="flex min-w-0 flex-col gap-4 pb-12">
			<div className="sticky top-0 z-20 -mx-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/45 bg-background/92 px-4 py-3 shadow-sm backdrop-blur-xl">
				<div className="flex min-w-0 items-center gap-3">
					<div
						className={cn(
							"flex size-9 items-center justify-center rounded-lg bg-muted",
							statusTone,
						)}
					>
						<Activity className="size-4" />
					</div>
					<div>
						<p className="font-semibold text-sm capitalize">
							{overview?.status ?? (loading ? "Checking" : "Unavailable")}
						</p>
						<p className="font-mono text-[11px] text-muted-foreground tabular-nums">
							{overview
								? `Run ${overview.runId} · ${overview.unseenCount} unseen`
								: "Loading diagnostics…"}
						</p>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						size="sm"
						variant="settings"
						onClick={() => setLive((value) => !value)}
					>
						{live ? <Pause /> : <Play />}
						{live ? "Pause live" : "Resume live"}
					</Button>
					<Button
						size="sm"
						variant="settings"
						aria-label="Refresh diagnostics"
						onClick={() => void refresh()}
					>
						<RefreshCw />
						Refresh
					</Button>
					<Button
						size="sm"
						variant="settings"
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
						loading={exporting}
						onClick={() => void exportBundle()}
					>
						<Archive />
						Export support bundle
					</Button>
				</div>
			</div>

			{error && (
				<div
					role="alert"
					className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/8 px-3 py-2 text-destructive text-xs"
				>
					<AlertTriangle className="mt-0.5 size-4 shrink-0" />
					<span>{error}</span>
				</div>
			)}

			<DiagnosticsSection
				title="Health overview"
				description="Current capture health across the desktop, renderer, server, and subprocesses."
			>
				<div className="grid grid-cols-2 divide-x divide-y divide-border/45 md:grid-cols-4">
					<Stat
						label="Failures"
						value={formatCount.format(
							(overview?.errorCount ?? 0) + (overview?.fatalCount ?? 0),
						)}
						tone={(overview?.errorCount ?? 0) > 0 ? "danger" : "default"}
					/>
					<Stat
						label="Warnings"
						value={formatCount.format(overview?.warningCount ?? 0)}
						tone={(overview?.warningCount ?? 0) > 0 ? "warning" : "default"}
					/>
					<Stat
						label="Slow operations"
						value={formatCount.format(overview?.slowOperationCount ?? 0)}
					/>
					<Stat
						label="Stored locally"
						value={formatBytes(overview?.storageBytes ?? 0)}
					/>
				</div>
			</DiagnosticsSection>

			<DiagnosticsSection
				title="Live processes"
				description="Server-owned agents and helper processes. Signals are ancestry-validated immediately before dispatch."
				action={<Server className="size-4 text-muted-foreground" />}
			>
				<div className="overflow-x-auto">
					<table className="w-full min-w-[780px] text-left text-xs">
						<thead className="border-b border-border/45 text-[10px] text-muted-foreground uppercase tracking-wider">
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
										className="px-4 py-2 font-medium"
										style={{
											paddingLeft: `${16 + Math.min(item.depth, 6) * 14}px`,
										}}
									>
										{item.name}
									</td>
									<td className="px-3 py-2 text-right font-mono tabular-nums">
										{item.cpuPercent.toFixed(1)}%
									</td>
									<td className="px-3 py-2 text-right font-mono tabular-nums">
										{formatBytes(item.rssBytes)}
									</td>
									<td
										className="max-w-72 truncate px-3 py-2 text-muted-foreground"
										title={item.command}
									>
										{item.command}
									</td>
									<td className="px-3 py-2 text-right font-mono tabular-nums">
										{item.pid}
									</td>
									<td className="px-4 py-2">
										<div className="flex justify-end gap-1">
											<Button
												size="xs"
												variant="ghost"
												disabled={item.pid === processes.serverPid}
												onClick={() =>
													void signalProcess(item.pid, "interrupt")
												}
											>
												Interrupt
											</Button>
											<Button
												size="xs"
												variant="destructive-outline"
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
					{!processes?.processes.length && (
						<Empty>{processes?.error ?? "No live descendant processes."}</Empty>
					)}
				</div>
			</DiagnosticsSection>

			<DiagnosticsSection
				title="Resource history"
				description="Five-second CPU and memory samples retained while this page is open."
				action={
					<div className="flex gap-1">
						{RANGE_OPTIONS.map((option) => (
							<button
								type="button"
								key={option.label}
								className={cn(
									"h-7 rounded-md px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
									rangeMs === option.milliseconds
										? "bg-muted text-foreground"
										: "text-muted-foreground hover:bg-muted/60",
								)}
								onClick={() => setRangeMs(option.milliseconds)}
							>
								{option.label}
							</button>
						))}
					</div>
				}
			>
				<div className="grid grid-cols-2 divide-x divide-border/45">
					<Stat
						label="Current CPU"
						value={`${(processes?.totalCpuPercent ?? 0).toFixed(1)}%`}
					/>
					<Stat
						label="Current memory"
						value={formatBytes(processes?.totalRssBytes ?? 0)}
					/>
				</div>
				<div
					className="flex h-32 items-end gap-1 border-t border-border/45 p-4"
					role="img"
					aria-label="Recent process CPU usage"
				>
					{samples.map((sample) => (
						<div
							key={sample.at}
							className="min-w-1 flex-1 rounded-t-sm bg-foreground/55"
							style={{ height: `${Math.max(3, (sample.cpu / maxCpu) * 100)}%` }}
							title={`${sample.cpu.toFixed(1)}% CPU · ${formatBytes(sample.memory)}`}
						/>
					))}
				</div>
			</DiagnosticsSection>

			<DiagnosticsSection
				title="Trace diagnostics"
				description="Structured spans, failures, slow operations, and parser health."
			>
				<div className="grid grid-cols-2 divide-x divide-y divide-border/45 md:grid-cols-4">
					<Stat
						label="Events"
						value={formatCount.format(overview?.eventCount ?? 0)}
					/>
					<Stat
						label="Failures"
						value={formatCount.format(overview?.errorCount ?? 0)}
						tone={(overview?.errorCount ?? 0) ? "danger" : "default"}
					/>
					<Stat
						label="Slow spans"
						value={formatCount.format(overview?.slowOperationCount ?? 0)}
					/>
					<Stat
						label="Parse errors"
						value={formatCount.format(overview?.parseErrorCount ?? 0)}
						tone={(overview?.parseErrorCount ?? 0) ? "warning" : "default"}
					/>
				</div>
			</DiagnosticsSection>

			<div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
				<DiagnosticsSection
					title="Latest incidents"
					description={`${events.length} matching events loaded`}
					action={
						<div className="flex items-center gap-1.5">
							<div className="relative">
								<Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
								<input
									aria-label="Search diagnostics"
									value={search}
									onChange={(event) => setSearch(event.target.value)}
									className="h-8 w-48 rounded-lg border border-border/50 bg-background pl-7 pr-2 text-xs outline-none focus:ring-2 focus:ring-ring"
									placeholder="Search errors"
								/>
							</div>
							<select
								aria-label="Filter severity"
								value={severity}
								onChange={(event) =>
									setSeverity(event.target.value as DiagnosticSeverity | "all")
								}
								className="h-8 rounded-lg border border-border/50 bg-background px-2 text-xs"
							>
								<option value="all">All levels</option>
								<option value="fatal">Fatal</option>
								<option value="error">Errors</option>
								<option value="warn">Warnings</option>
								<option value="info">Info</option>
							</select>
						</div>
					}
				>
					<div className="border-b border-border/45 px-4 py-2">
						<label className="flex max-w-sm items-center gap-2 text-muted-foreground text-xs">
							<span>Source</span>
							<input
								aria-label="Filter diagnostic source"
								value={source}
								onChange={(event) => setSource(event.target.value)}
								className="h-7 flex-1 rounded-md border border-border/50 bg-background px-2 text-foreground outline-none focus:ring-2 focus:ring-ring"
								placeholder="All sources"
							/>
						</label>
					</div>
					<div className="max-h-[520px] overflow-auto">
						<table className="w-full min-w-[640px] text-left text-xs">
							<thead className="sticky top-0 border-b border-border/45 bg-card">
								<tr>
									<th className="px-4 py-2">Level</th>
									<th className="px-3 py-2">Source</th>
									<th className="px-3 py-2">Message</th>
									<th className="px-4 py-2 text-right">Seen</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-border/40">
								{events.map((item) => (
									<tr
										key={item.id}
										className={cn(
											"cursor-pointer hover:bg-muted/25 focus-within:bg-muted/25",
											selected?.id === item.id && "bg-muted/40",
										)}
									>
										<td className="px-4 py-2">
											<SeverityPill severity={item.severity} />
										</td>
										<td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
											{item.source}
										</td>
										<td className="px-3 py-2">
											<button
												type="button"
												className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
												onClick={() => setSelected(item)}
											>
												{item.message}
											</button>
										</td>
										<td className="whitespace-nowrap px-4 py-2 text-right font-mono text-muted-foreground tabular-nums">
											{relativeTime(item.createdAt)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
						{events.length === 0 && (
							<Empty>No incidents match these filters.</Empty>
						)}
						{nextEventCursor && (
							<div className="flex items-center justify-between border-t border-border/45 px-4 py-3 text-muted-foreground text-xs">
								<span>
									{formatCount.format(events.length)} of{" "}
									{formatCount.format(eventTotal)}
								</span>
								<Button
									size="sm"
									variant="settings"
									onClick={() => void loadMoreEvents()}
								>
									Load more
								</Button>
							</div>
						)}
					</div>
				</DiagnosticsSection>
				<aside
					className="self-start rounded-xl border border-border/50 bg-card/70 p-4 shadow-xs xl:sticky xl:top-20"
					aria-label="Incident details"
				>
					{selected ? (
						<div className="space-y-4">
							<div className="flex items-start justify-between gap-3">
								<div>
									<SeverityPill severity={selected.severity} />
									<h3 className="mt-2 font-semibold text-sm">
										{selected.message}
									</h3>
								</div>
								<Button
									size="icon-xs"
									variant="ghost"
									aria-label="Copy diagnostic ID"
									onClick={() =>
										void navigator.clipboard.writeText(selected.id)
									}
								>
									<Copy />
								</Button>
							</div>
							<dl className="grid grid-cols-[90px_1fr] gap-2 text-xs">
								<dt className="text-muted-foreground">Diagnostic ID</dt>
								<dd className="break-all font-mono">{selected.id}</dd>
								<dt className="text-muted-foreground">Source</dt>
								<dd className="font-mono">{selected.source}</dd>
								<dt className="text-muted-foreground">Run</dt>
								<dd className="font-mono">{selected.runId}</dd>
								<dt className="text-muted-foreground">Recovery</dt>
								<dd>{selected.recoveryStatus}</dd>
								<dt className="text-muted-foreground">Trace</dt>
								<dd className="break-all font-mono">
									{selected.traceId ?? "Not correlated"}
								</dd>
							</dl>
							{selected.detail && (
								<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 text-[11px] leading-5">
									{selected.detail}
								</pre>
							)}
							<Button
								size="sm"
								variant="settings"
								onClick={() =>
									void navigator.clipboard.writeText(
										`${selected.id}\n${selected.message}\n${selected.detail ?? ""}`,
									)
								}
							>
								<Copy />
								Copy details
							</Button>
						</div>
					) : (
						<div className="flex min-h-48 flex-col items-center justify-center text-center">
							<ShieldCheck className="size-6 text-muted-foreground" />
							<p className="mt-2 font-medium text-sm">Select an incident</p>
							<p className="mt-1 max-w-52 text-muted-foreground text-xs">
								Inspect its sanitized details, correlation IDs, and recovery
								state.
							</p>
						</div>
					)}
				</aside>
			</div>

			<DiagnosticsSection
				title="Most common failures"
				description="Repeated incidents grouped by stable fingerprint."
			>
				{overview?.commonFailures.length ? (
					<div className="divide-y divide-border/40">
						{overview.commonFailures.map((group) => (
							<div
								key={group.fingerprint}
								className="grid grid-cols-[1fr_auto] gap-4 px-4 py-3 text-xs"
							>
								<div>
									<p className="font-medium">{group.message}</p>
									<p className="mt-1 font-mono text-[11px] text-muted-foreground">
										{group.source} · {group.fingerprint}
									</p>
								</div>
								<div className="text-right">
									<p className="font-mono font-semibold tabular-nums">
										{group.count}×
									</p>
									<p className="text-muted-foreground">
										{relativeTime(group.lastSeenAt)}
									</p>
								</div>
							</div>
						))}
					</div>
				) : (
					<Empty>No repeated failures in this range.</Empty>
				)}
			</DiagnosticsSection>

			<DiagnosticsSection
				title="Slowest operations"
				description="Operations taking one second or longer."
			>
				{overview?.slowestOperations.length ? (
					<div className="divide-y divide-border/40">
						{overview.slowestOperations.map((item) => (
							<div
								key={item.id}
								className="grid grid-cols-[1fr_auto] gap-4 px-4 py-3 text-xs"
							>
								<div>
									<p className="font-medium">{item.message}</p>
									<p className="mt-1 font-mono text-muted-foreground">
										{item.source} · {item.traceId ?? item.id}
									</p>
								</div>
								<p className="font-mono font-semibold tabular-nums">
									{formatDuration(item.durationMs ?? 0)}
								</p>
							</div>
						))}
					</div>
				) : (
					<Empty>No slow operations captured.</Empty>
				)}
			</DiagnosticsSection>

			<DiagnosticsSection
				title="Warning and error logs"
				description="Sanitized structured events from every application boundary."
			>
				<div className="divide-y divide-border/40">
					{events
						.filter(
							(item) =>
								item.severity === "warn" ||
								item.severity === "error" ||
								item.severity === "fatal",
						)
						.slice(0, 20)
						.map((item) => (
							<button
								type="button"
								key={item.id}
								onClick={() => setSelected(item)}
								className="grid w-full grid-cols-[70px_160px_1fr_auto] gap-3 px-4 py-3 text-left text-xs hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
							>
								<SeverityPill severity={item.severity} />
								<span className="truncate font-mono text-muted-foreground">
									{item.source}
								</span>
								<span className="truncate">{item.message}</span>
								<span className="font-mono text-muted-foreground tabular-nums">
									{relativeTime(item.createdAt)}
								</span>
							</button>
						))}
				</div>
			</DiagnosticsSection>

			<DiagnosticsSection
				title="Top operations"
				description="Count, failures, average, p95, and maximum duration."
			>
				{overview?.topOperations.length ? (
					<div className="divide-y divide-border/40">
						{overview.topOperations.map((item) => (
							<div
								key={item.name}
								className="grid grid-cols-[1fr_repeat(4,90px)] gap-3 px-4 py-3 text-xs"
							>
								<span className="font-medium">{item.name}</span>
								<span className="text-right font-mono tabular-nums">
									{item.count}
								</span>
								<span className="text-right font-mono tabular-nums">
									{item.failureCount}
								</span>
								<span className="text-right font-mono tabular-nums">
									{formatDuration(item.p95DurationMs)}
								</span>
								<span className="text-right font-mono tabular-nums">
									{formatDuration(item.maxDurationMs)}
								</span>
							</div>
						))}
					</div>
				) : (
					<Empty>
						Operation summaries appear as instrumented traces are captured.
					</Empty>
				)}
			</DiagnosticsSection>

			<DiagnosticsSection
				title="Storage and capture tools"
				description="Diagnostics stay on this device unless you explicitly export them."
			>
				<div className="grid gap-3 p-4 md:grid-cols-3">
					<div className="rounded-lg bg-muted/35 p-3">
						<p className="font-medium text-xs">Retention</p>
						<p className="mt-1 text-muted-foreground text-xs">
							7 days · 250 MB maximum
						</p>
					</div>
					<div className="rounded-lg bg-muted/35 p-3">
						<p className="font-medium text-xs">Verbose capture</p>
						<p className="mt-1 text-muted-foreground text-xs">
							Off · secrets and conversation content excluded
						</p>
					</div>
					<div className="rounded-lg bg-muted/35 p-3">
						<p className="font-medium text-xs">Remote export</p>
						<p className="mt-1 text-muted-foreground text-xs">
							Disabled · local-first
						</p>
					</div>
				</div>
				<div className="flex flex-wrap gap-2 border-t border-border/45 p-4">
					<Button
						size="sm"
						onClick={() => void exportBundle()}
						loading={exporting}
					>
						<Archive />
						Export support bundle
					</Button>
					<Button
						size="sm"
						variant="settings"
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
			</DiagnosticsSection>
		</div>
	);
}
