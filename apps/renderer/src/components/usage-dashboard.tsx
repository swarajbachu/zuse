import type {
	FolderId,
	ProviderId,
	ProviderUsageLimits,
	UsageGroup,
	UsageOverview,
} from "@zuse/contracts";
import {
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	RefreshCw,
	Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Bar } from "~/components/dither-kit/bar";
import { BarChart } from "~/components/dither-kit/bar-chart";
import { Grid } from "~/components/dither-kit/grid";
import { XAxis } from "~/components/dither-kit/x-axis";
import { YAxis } from "~/components/dither-kit/y-axis";
import { useUsageSessions } from "~/hooks/use-usage-sessions";
import { PROVIDER_DISPLAY } from "~/lib/provider-status";
import { usagePace } from "~/lib/usage-pace";
import { cn } from "~/lib/utils";
import { useUiStore } from "~/store/ui";
import {
	type UsagePeriod,
	type UsageRange,
	useUsageStore,
} from "~/store/usage.ts";
import { useUsageLimitsStore } from "~/store/usage-limits";
import { formatTokens, formatUsd, totalTokens } from "../lib/format-usage.ts";
import { ProviderIcon } from "./provider-icons";
import { Button } from "./ui/button.tsx";
import {
	Frame,
	FrameFooter,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from "./ui/frame.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./ui/table.tsx";
import { resetLabel, StickMeter } from "./usage/usage-meter";

const PERIODS: ReadonlyArray<{ value: UsagePeriod; label: string }> = [
	{ value: "7d", label: "7D" },
	{ value: "30d", label: "30D" },
	{ value: "90d", label: "90D" },
];
const PAGE_SIZE = 10;
const LIMIT_SCOPE_ORDER = {
	session: 0,
	weekly: 1,
	overall: 2,
	model: 3,
} as const;
const PROVIDER_ORDER: ReadonlyArray<ProviderId> = [
	"claude",
	"codex",
	"grok",
	"gemini",
	"kiro",
];

export function UsageDashboard({
	projectId,
	availableProjectId,
	scopeLabel,
}: {
	projectId: FolderId | null;
	availableProjectId: FolderId | null;
	scopeLabel: string;
}) {
	const report = useUsageStore((state) => state.report);
	const loading = useUsageStore((state) => state.loading);
	const refreshing = useUsageStore((state) => state.refreshing);
	const error = useUsageStore((state) => state.error);
	const period = useUsageStore((state) => state.period);
	const refresh = useUsageStore((state) => state.refresh);
	const setPeriod = useUsageStore((state) => state.setPeriod);
	const selectedRange = useUsageStore((state) => state.selectedRange);
	const setRange = useUsageStore((state) => state.setRange);
	const refreshLimits = useUsageLimitsStore((state) => state.refresh);
	const loadLimitHistory = useUsageLimitsStore((state) => state.loadHistory);
	const openUsage = useUiStore((state) => state.openUsage);

	useEffect(() => {
		void refresh(projectId);
		void refreshLimits(false);
		void loadLimitHistory();
	}, [projectId, refresh, refreshLimits, loadLimitHistory]);

	const forceRefresh = () => {
		void Promise.all([
			refresh(projectId, { forceRefresh: true }),
			refreshLimits(true).then(loadLimitHistory),
		]);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border px-4">
				<div className="min-w-0">
					<h1 className="truncate text-sm font-medium">Usage</h1>
					<p className="truncate text-[11px] text-muted-foreground">
						{scopeLabel}
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<fieldset
						className="flex rounded-md border border-border p-0.5"
						aria-label="Usage scope"
					>
						<button
							type="button"
							onClick={() => openUsage("global")}
							className={cn(
								"min-h-7 rounded px-2 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-foreground/30",
								projectId === null
									? "bg-accent text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
							aria-pressed={projectId === null}
						>
							All projects
						</button>
						<button
							type="button"
							disabled={availableProjectId === null}
							onClick={() => openUsage("project")}
							className={cn(
								"min-h-7 rounded px-2 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 disabled:opacity-50",
								projectId !== null
									? "bg-accent text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
							aria-pressed={projectId !== null}
						>
							Current
						</button>
					</fieldset>
					<fieldset
						className="flex rounded-md border border-border p-0.5"
						aria-label="Usage period"
					>
						{PERIODS.map((item) => (
							<button
								key={item.value}
								type="button"
								onClick={() => void setPeriod(item.value, projectId)}
								className={cn(
									"min-h-7 rounded px-2 text-[11px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-foreground/30",
									period === item.value
										? "bg-foreground text-background"
										: "text-muted-foreground hover:text-foreground",
								)}
								aria-pressed={period === item.value}
							>
								{item.label}
							</button>
						))}
					</fieldset>
					<button
						type="button"
						onClick={forceRefresh}
						className="inline-flex size-8 items-center justify-center rounded-md border border-border text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/30"
						title="Refresh usage"
						aria-label="Refresh usage"
					>
						<RefreshCw
							className={cn(
								"size-3.5",
								refreshing && "animate-spin motion-reduce:animate-none",
							)}
						/>
					</button>
				</div>
			</header>

			{error !== null && report !== null ? (
				<div className="mx-4 mt-3 rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
					Showing saved usage. Refresh failed: {error}
				</div>
			) : null}

			{report === null ? (
				loading ? (
					<UsageSkeleton />
				) : (
					<EmptyState error={error} />
				)
			) : (
				<UsageReportView
					report={report}
					refreshing={refreshing}
					projectId={projectId}
					period={period}
					selectedRange={selectedRange}
					onSelectRange={(range) => void setRange(range, projectId)}
				/>
			)}
		</div>
	);
}

function UsageSkeleton() {
	return (
		<div
			className="mx-auto min-h-0 w-full max-w-6xl flex-1 space-y-6 overflow-hidden px-6 py-6"
			role="status"
			aria-label="Loading usage"
		>
			<span className="sr-only">Loading usage…</span>
			<div className="grid h-32 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
				{Array.from({ length: PROVIDER_ORDER.length }, (_, index) => (
					<div
						key={index}
						className="rounded-lg border border-border bg-muted/20"
					/>
				))}
			</div>
			<div className="grid h-28 grid-cols-1 gap-3 sm:grid-cols-3">
				{Array.from({ length: 3 }, (_, index) => (
					<div
						key={index}
						className="rounded-lg border border-border bg-muted/20"
					/>
				))}
			</div>
			<div className="h-72 rounded-lg border border-border bg-muted/20" />
		</div>
	);
}

function EmptyState({ error }: { error: string | null }) {
	return (
		<div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
			{error ?? "No usage has been recorded yet."}
		</div>
	);
}

function UsageReportView({
	report,
	refreshing,
	projectId,
	period,
	selectedRange,
	onSelectRange,
}: {
	report: UsageOverview;
	refreshing: boolean;
	projectId: FolderId | null;
	period: UsagePeriod;
	selectedRange: UsageRange | null;
	onSelectRange: (range: UsageRange | null) => void;
}) {
	const summary = report.summary;
	const previous = report.previousSummary;
	const metrics = [
		{
			label: "Cost",
			value: formatUsd(summary.costUsd),
			hint:
				summary.costStatus === "partial"
					? "Some models are unpriced"
					: summary.costStatus === "unknown"
						? "Pricing unavailable"
						: "Estimated from local usage",
			delta: metricDelta(summary.costUsd, previous?.costUsd ?? null),
		},
		{
			label: "Tokens",
			value: formatTokens(totalTokens(summary)),
			hint: `${formatTokens(summary.inputTokens)} in · ${formatTokens(summary.outputTokens)} out`,
			delta: metricDelta(
				totalTokens(summary),
				previous ? totalTokens(previous) : null,
			),
		},
		{
			label: "Active sessions",
			value: report.sessionCount.toLocaleString(),
			hint: `${summary.recordCount.toLocaleString()} usage records`,
			delta: metricDelta(report.sessionCount, report.previousSessionCount),
		},
	];

	return (
		<div className="min-h-0 flex-1 overflow-auto">
			<div className="mx-auto w-full max-w-6xl space-y-6 px-6 py-6">
				<LimitStrip />
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
					{metrics.map((metric) => (
						<Metric key={metric.label} {...metric} />
					))}
				</div>
				<UsageChart
					groups={report.groups}
					selectedRange={selectedRange}
					onSelectRange={onSelectRange}
				/>
				<Contributors
					bySource={report.bySource}
					byModel={report.byModel}
					byProject={report.byProject}
					previousBySource={report.previousBySource}
					previousByModel={report.previousByModel}
					previousByProject={report.previousByProject}
				/>
				<SessionsExplorer
					projectId={projectId}
					period={period}
					sessionCount={report.sessionCount}
					selectedRange={selectedRange}
				/>
				<div className="flex items-center justify-between text-[10px] text-muted-foreground">
					<span>
						{report.sources.filter((source) => source.detected).length} sources
						detected
					</span>
					<span className="tabular-nums">
						{refreshing
							? "Updating…"
							: `Updated ${report.generatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
					</span>
				</div>
			</div>
		</div>
	);
}

function LimitStrip() {
	const providers = useUsageLimitsStore((state) => state.providers);
	const loading = useUsageLimitsStore((state) => state.loading);
	// Always paint every limits-capable provider (incl. Kiro) in a stable
	// order so a missing/empty API row cannot hide a card.
	const cards = useMemo(() => {
		const byId = new Map(
			providers.map((provider) => [provider.providerId, provider] as const),
		);
		return PROVIDER_ORDER.map((id) => {
			const provider = byId.get(id);
			if (provider === undefined) {
				return { id, kind: "placeholder" as const };
			}
			const hasData =
				provider.windows.length > 0 || provider.creditsRemaining !== null;
			if (!hasData && provider.unavailableReason !== undefined) {
				return {
					id,
					kind: "placeholder" as const,
					reason: provider.unavailableReason,
				};
			}
			return { id, kind: "card" as const, provider };
		});
	}, [providers]);

	return (
		<section aria-labelledby="limits-title">
			<h2
				id="limits-title"
				className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
			>
				Limits
			</h2>
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
				{cards.map((entry) =>
					entry.kind === "card" ? (
						<LimitCard key={entry.id} provider={entry.provider} />
					) : (
						<LimitPlaceholder
							key={entry.id}
							providerId={entry.id}
							unavailable={providers.length > 0 || !loading}
							reason={"reason" in entry ? entry.reason : undefined}
						/>
					),
				)}
			</div>
		</section>
	);
}

function LimitPlaceholder({
	providerId,
	unavailable = false,
	reason,
}: {
	providerId: ProviderId;
	unavailable?: boolean;
	reason?: ProviderUsageLimits["unavailableReason"];
}) {
	const message = !unavailable
		? "Checking limits…"
		: reason === "no-credentials"
			? providerId === "kiro"
				? "Sign in with kiro-cli login"
				: "Sign in to see limits"
			: reason === "expired"
				? providerId === "kiro"
					? "Session expired — run kiro-cli login"
					: "Session expired — sign in again"
				: reason === "error"
					? "Could not load limits"
					: reason === "unsupported"
						? "Not available for this account"
						: "No usage data available";
	return (
		<div className="h-28 rounded-lg border border-border bg-card p-3">
			<div className="flex items-center gap-2 text-xs">
				<ProviderIcon providerId={providerId} className="size-4" />
				{PROVIDER_DISPLAY[providerId]}
			</div>
			<div className="mt-8 text-[11px] text-muted-foreground">{message}</div>
		</div>
	);
}

function LimitCard({ provider }: { provider: ProviderUsageLimits }) {
	const history = useUsageLimitsStore((state) => state.history);
	const [expanded, setExpanded] = useState(false);
	const windows = useMemo(
		() =>
			provider.windows
				.slice()
				.sort(
					(a, b) => LIMIT_SCOPE_ORDER[a.scope] - LIMIT_SCOPE_ORDER[b.scope],
				),
		[provider.windows],
	);
	const primary = windows[0];
	const left =
		primary?.usedPercent == null
			? null
			: Math.max(0, Math.round(100 - primary.usedPercent));
	const pace = primary
		? usagePace(primary.usedPercent, primary.resetsAt, primary.windowMinutes)
		: null;
	const historyValues = useMemo(
		() =>
			history
				.filter(
					(point) =>
						point.providerId === provider.providerId &&
						point.windowId === primary?.id &&
						point.usedPercent !== null,
				)
				.slice(-24)
				.map((point) => point.usedPercent as number),
		[history, primary?.id, provider.providerId],
	);
	return (
		<button
			type="button"
			onClick={() => setExpanded((value) => !value)}
			className={cn(
				"min-h-28 rounded-lg border border-border bg-card p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-foreground/30",
				expanded && "col-span-2 lg:col-span-1",
			)}
			aria-expanded={expanded}
		>
			<div className="flex items-center gap-2">
				<ProviderIcon providerId={provider.providerId} className="size-4" />
				<span className="min-w-0 flex-1 truncate text-xs font-medium">
					{PROVIDER_DISPLAY[provider.providerId]}
				</span>
				<ChevronDown
					className={cn(
						"size-3.5 text-muted-foreground transition-transform motion-reduce:transition-none",
						expanded && "rotate-180",
					)}
				/>
			</div>
			<div className="mt-1 h-4 truncate text-[10px] text-muted-foreground">
				{provider.planLabel ?? primary?.label ?? "Usage limits"}
			</div>
			{primary ? (
				<>
					<div className="mt-2 flex items-end justify-between gap-2">
						<span className="text-xl font-semibold tracking-tight tabular-nums">
							{left == null ? "—" : `${left}%`}
							{left != null ? (
								<span className="ml-0.5 text-[11px] font-medium text-muted-foreground">
									left
								</span>
							) : null}
						</span>
						<span className="mb-0.5 text-[10px] text-muted-foreground">
							{resetLabel(primary.resetsAt) ?? "No reset"}
						</span>
					</div>
					<StickMeter
						percent={primary.usedPercent}
						tone={(primary.usedPercent ?? 0) >= 80 ? "warning" : "default"}
					/>
					{historyValues.length > 1 ? (
						<UsageSparkline values={historyValues} />
					) : null}
					{pace ? (
						<div
							className={cn(
								"mt-1 text-[10px]",
								pace.tone === "reserve"
									? "text-emerald-600 dark:text-emerald-400"
									: "text-amber-600 dark:text-amber-400",
							)}
						>
							{pace.label}
						</div>
					) : null}
				</>
			) : provider.creditsRemaining !== null ? (
				<div className="mt-2 flex items-end justify-between gap-2">
					<span className="text-xl font-semibold tracking-tight tabular-nums">
						{provider.creditsRemaining.toLocaleString(undefined, {
							maximumFractionDigits: 1,
						})}
					</span>
					<span className="mb-0.5 text-[10px] text-muted-foreground">
						credits left
					</span>
				</div>
			) : (
				<div className="mt-7 text-[11px] text-muted-foreground">
					No usage data available
				</div>
			)}
			{provider.creditsRemaining !== null && primary ? (
				<div className="mt-2 flex items-center justify-between border-t border-border/60 pt-2 text-[10px]">
					<span className="text-muted-foreground">Credits remaining</span>
					<span className="font-medium tabular-nums">
						{provider.creditsRemaining.toLocaleString(undefined, {
							maximumFractionDigits: 1,
						})}
					</span>
				</div>
			) : null}
			{expanded && windows.length > 1 ? (
				<div className="mt-3 space-y-2 border-t border-border/60 pt-2">
					{windows.slice(1).map((window) => (
						<div key={window.id}>
							<div className="mb-1 flex justify-between gap-2 text-[10px]">
								<span className="truncate">{window.label}</span>
								<span className="shrink-0 tabular-nums text-muted-foreground">
									{window.usedPercent == null
										? "—"
										: `${Math.max(0, Math.round(100 - window.usedPercent))}% left`}
								</span>
							</div>
							<StickMeter
								percent={window.usedPercent}
								tone={(window.usedPercent ?? 0) >= 80 ? "warning" : "default"}
							/>
						</div>
					))}
				</div>
			) : null}
		</button>
	);
}

function UsageSparkline({ values }: { values: ReadonlyArray<number> }) {
	const points = values
		.map((value, index) => {
			const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 100;
			return `${x},${20 - (Math.min(100, Math.max(0, value)) / 100) * 20}`;
		})
		.join(" ");
	return (
		<svg
			viewBox="0 0 100 20"
			preserveAspectRatio="none"
			className="mt-1.5 h-4 w-full overflow-visible text-primary/55"
			aria-label="Recent usage trend"
			role="img"
		>
			<polyline
				points={points}
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

function Metric({
	label,
	value,
	hint,
	delta,
}: {
	label: string;
	value: string;
	hint: string;
	delta: string | null;
}) {
	return (
		<Frame>
			<FramePanel className="h-28 p-4">
				<div className="flex items-center justify-between gap-2">
					<div className="text-[11px] font-medium text-muted-foreground">
						{label}
					</div>
					{delta ? (
						<div className="text-[10px] tabular-nums text-muted-foreground">
							{delta}
						</div>
					) : null}
				</div>
				<div
					className="mt-2 truncate text-2xl font-semibold tracking-tight tabular-nums"
					title={value}
				>
					{value}
				</div>
				<div
					className="mt-2 truncate text-[10px] text-muted-foreground"
					title={hint}
				>
					{hint}
				</div>
			</FramePanel>
		</Frame>
	);
}

function metricDelta(
	current: number | null,
	previous: number | null,
): string | null {
	if (current === null || previous === null || previous === 0) return null;
	const value = Math.round(((current - previous) / previous) * 100);
	return `${value > 0 ? "+" : ""}${value}% vs prior`;
}

type ChartMeasure = "tokens" | "cost";
function UsageChart({
	groups,
	selectedRange,
	onSelectRange,
}: {
	groups: ReadonlyArray<UsageGroup>;
	selectedRange: UsageRange | null;
	onSelectRange: (range: UsageRange | null) => void;
}) {
	const [measure, setMeasure] = useState<ChartMeasure>("tokens");
	const [hovered, setHovered] = useState<number | null>(null);
	const visible = useMemo(() => groups.slice(-90), [groups]);
	const chartData = useMemo(
		() =>
			visible.map((group) => ({
				label: group.label,
				value: measure === "cost" ? (group.costUsd ?? 0) : totalTokens(group),
			})),
		[measure, visible],
	);
	const detail = hovered === null ? null : visible[hovered];
	const chartConfig = useMemo(
		() => ({
			value: {
				label: measure === "cost" ? "Estimated cost" : "Tokens",
				color: "blue" as const,
			},
		}),
		[measure],
	);
	return (
		<Frame>
			<FrameHeader className="flex-row items-center justify-between px-4 py-3">
				<div className="flex min-w-0 items-center gap-2">
					<FrameTitle>Usage over time</FrameTitle>
					{selectedRange ? (
						<button
							type="button"
							onClick={() => onSelectRange(null)}
							className="truncate rounded bg-accent px-2 py-1 text-[10px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/30"
						>
							{selectedRange.label} · Clear
						</button>
					) : null}
				</div>
				<div className="flex shrink-0 rounded-md border border-border p-0.5">
					{(["tokens", "cost"] as const).map((value) => (
						<button
							key={value}
							type="button"
							onClick={() => setMeasure(value)}
							className={cn(
								"min-h-7 rounded px-2 text-[11px] capitalize outline-none focus-visible:ring-2 focus-visible:ring-foreground/30",
								measure === value
									? "bg-foreground text-background"
									: "text-muted-foreground hover:text-foreground",
							)}
							aria-pressed={measure === value}
						>
							{value}
						</button>
					))}
				</div>
			</FrameHeader>
			<FramePanel className="p-4">
				<div className="mb-3 h-4 text-[10px] text-muted-foreground">
					{measure === "cost"
						? "Estimated cost by day"
						: "Processed tokens by day"}
				</div>
				{visible.length === 0 ? (
					<div className="flex h-52 items-center justify-center text-sm text-muted-foreground">
						No usage in this period.
					</div>
				) : (
					<>
						<div className="h-52 w-full">
							<BarChart
								data={chartData}
								config={chartConfig}
								animate={false}
								bloom="off"
								onHoverChange={setHovered}
							>
								<Grid />
								<XAxis dataKey="label" maxTicks={7} />
								<YAxis
									tickCount={4}
									tickFormatter={measure === "cost" ? formatUsd : formatTokens}
								/>
								<Bar dataKey="value" variant="dotted" />
							</BarChart>
						</div>
						<div
							className="mt-3 flex h-9 items-center justify-between gap-3 rounded-md bg-muted/35 px-3 text-[11px]"
							aria-live="polite"
						>
							{detail ? (
								<>
									<span className="truncate font-medium">{detail.label}</span>
									<div className="flex shrink-0 items-center gap-3">
										<span className="tabular-nums text-muted-foreground">
											{formatTokens(totalTokens(detail))} ·{" "}
											{formatUsd(detail.costUsd)}
										</span>
										{detail.startedAt ? (
											<button
												type="button"
												className="rounded px-1.5 py-1 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-foreground/30"
												onClick={() =>
													onSelectRange({
														since: detail.startedAt as Date,
														until:
															detail.endedAt ??
															new Date(
																(detail.startedAt as Date).getTime() +
																	86_400_000,
															),
														label: detail.label,
													})
												}
											>
												View day
											</button>
										) : null}
									</div>
								</>
							) : (
								<span className="text-muted-foreground">
									Select a bar for details
								</span>
							)}
						</div>
					</>
				)}
			</FramePanel>
		</Frame>
	);
}

type ContributorTab = "providers" | "models" | "projects";
function Contributors({
	bySource,
	byModel,
	byProject,
	previousBySource,
	previousByModel,
	previousByProject,
}: {
	bySource: ReadonlyArray<UsageGroup>;
	byModel: ReadonlyArray<UsageGroup>;
	byProject: ReadonlyArray<UsageGroup>;
	previousBySource: ReadonlyArray<UsageGroup>;
	previousByModel: ReadonlyArray<UsageGroup>;
	previousByProject: ReadonlyArray<UsageGroup>;
}) {
	const [tab, setTab] = useState<ContributorTab>("providers");
	const [expanded, setExpanded] = useState(false);
	const rows = useMemo(
		() =>
			(tab === "providers" ? bySource : tab === "models" ? byModel : byProject)
				.slice()
				.sort((a, b) => totalTokens(b) - totalTokens(a)),
		[bySource, byModel, byProject, tab],
	);
	const visible = expanded ? rows : rows.slice(0, 5);
	const previousRows =
		tab === "providers"
			? previousBySource
			: tab === "models"
				? previousByModel
				: previousByProject;
	const total = Math.max(
		1,
		rows.reduce((sum, row) => sum + totalTokens(row), 0),
	);
	return (
		<Frame>
			<FrameHeader className="flex-row items-center justify-between px-4 py-3">
				<FrameTitle>Top contributors</FrameTitle>
				<div className="flex gap-1">
					{(["providers", "models", "projects"] as const).map((value) => (
						<button
							key={value}
							type="button"
							onClick={() => {
								setTab(value);
								setExpanded(false);
							}}
							className={cn(
								"rounded px-2 py-1 text-[11px] capitalize outline-none focus-visible:ring-2 focus-visible:ring-foreground/30",
								tab === value
									? "bg-accent text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
							aria-pressed={tab === value}
						>
							{value}
						</button>
					))}
				</div>
			</FrameHeader>
			<FramePanel className="p-0">
				{visible.length === 0 ? (
					<div className="p-4 text-sm text-muted-foreground">
						No contributors found.
					</div>
				) : (
					visible.map((row) => {
						const share = (totalTokens(row) / total) * 100;
						const previous = previousRows.find((item) => item.key === row.key);
						const delta = metricDelta(
							totalTokens(row),
							previous ? totalTokens(previous) : null,
						);
						return (
							<div
								key={row.key}
								className="relative border-b border-border/50 last:border-0"
							>
								<div
									className="absolute inset-y-0 left-0 bg-primary/[0.08]"
									style={{ width: `${share}%` }}
								/>
								<div className="relative flex items-center gap-3 px-4 py-2.5">
									<div className="min-w-0 flex-1">
										<div className="truncate text-xs" title={row.label}>
											{row.label}
										</div>
										<div className="text-[10px] tabular-nums text-muted-foreground">
											{share.toFixed(1)}% of usage
											{delta ? ` · ${delta}` : ""}
										</div>
									</div>
									<div className="shrink-0 text-right text-xs tabular-nums">
										<div>{formatTokens(totalTokens(row))}</div>
										<div className="text-[10px] text-muted-foreground">
											{formatUsd(row.costUsd)}
										</div>
									</div>
								</div>
							</div>
						);
					})
				)}
			</FramePanel>
			{rows.length > 5 ? (
				<FrameFooter className="p-2">
					<button
						type="button"
						onClick={() => setExpanded((value) => !value)}
						className="mx-auto rounded px-2 py-1 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/30"
					>
						{expanded ? "Show less" : `View all ${rows.length}`}
					</button>
				</FrameFooter>
			) : null}
		</Frame>
	);
}

type SortKey = "tokens" | "cost" | "last-active";
function SessionsExplorer({
	projectId,
	period,
	sessionCount,
	selectedRange,
}: {
	projectId: FolderId | null;
	period: UsagePeriod;
	sessionCount: number;
	selectedRange: UsageRange | null;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [sortKey, setSortKey] = useState<SortKey>("tokens");
	const [providerId, setProviderId] = useState<ProviderId | null>(null);
	const [pageIndex, setPageIndex] = useState(0);
	const {
		page: pageData,
		loading,
		error,
	} = useUsageSessions({
		enabled: open,
		projectId,
		period,
		since: selectedRange?.since,
		until: selectedRange?.until,
		query,
		providerId,
		sort: sortKey,
		offset: pageIndex * PAGE_SIZE,
		limit: PAGE_SIZE,
	});
	const filtered = pageData?.rows ?? [];
	const total = pageData?.total ?? sessionCount;
	const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const page = Math.min(pageIndex, pageCount - 1);
	return (
		<Frame>
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="flex w-full items-center justify-between px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-foreground/30"
				aria-expanded={open}
			>
				<span>
					<span className="block text-sm font-medium">Sessions</span>
					<span className="block text-[10px] text-muted-foreground">
						{sessionCount.toLocaleString()} in this period
					</span>
				</span>
				<ChevronDown
					className={cn(
						"size-4 text-muted-foreground transition-transform motion-reduce:transition-none",
						open && "rotate-180",
					)}
				/>
			</button>
			{open ? (
				<>
					<div className="flex gap-2 border-t border-border px-3 py-2">
						<label className="relative min-w-0 flex-1">
							<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
							<input
								type="search"
								value={query}
								onChange={(event) => {
									setQuery(event.target.value);
									setPageIndex(0);
								}}
								placeholder="Search sessions"
								className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-foreground/30"
								aria-label="Search sessions"
							/>
						</label>
						<select
							value={providerId ?? ""}
							onChange={(event) => {
								setProviderId(
									(event.target.value || null) as ProviderId | null,
								);
								setPageIndex(0);
							}}
							className="h-8 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-foreground/30"
							aria-label="Filter sessions by provider"
						>
							<option value="">All providers</option>
							{PROVIDER_ORDER.map((id) => (
								<option key={id} value={id}>
									{PROVIDER_DISPLAY[id]}
								</option>
							))}
						</select>
					</div>
					{error ? (
						<div className="border-t border-border px-3 py-2 text-xs text-destructive">
							Could not load sessions. Change a filter or try again.
						</div>
					) : null}
					<Table variant="card" className="table-fixed">
						<TableHeader>
							<TableRow className="hover:bg-transparent">
								<TableHead className="w-[46%]">Session</TableHead>
								<SortableHead
									label="Last active"
									active={sortKey === "last-active"}
									onClick={() => {
										setSortKey("last-active");
										setPageIndex(0);
									}}
								/>
								<SortableHead
									label="Tokens"
									active={sortKey === "tokens"}
									onClick={() => {
										setSortKey("tokens");
										setPageIndex(0);
									}}
								/>
								<SortableHead
									label="Cost"
									active={sortKey === "cost"}
									onClick={() => {
										setSortKey("cost");
										setPageIndex(0);
									}}
								/>
							</TableRow>
						</TableHeader>
						<TableBody>
							{loading && pageData === null ? (
								<TableRow>
									<TableCell
										colSpan={4}
										className="h-20 text-center text-muted-foreground"
									>
										Loading sessions…
									</TableCell>
								</TableRow>
							) : (
								filtered.map((row) => (
									<TableRow key={row.key}>
										<TableCell>
											<div className="truncate font-medium" title={row.label}>
												{row.label}
											</div>
										</TableCell>
										<TableCell className="truncate text-right text-muted-foreground">
											{lastActive(row)}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatTokens(totalTokens(row))}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatUsd(row.costUsd)}
										</TableCell>
									</TableRow>
								))
							)}
						</TableBody>
					</Table>
					<FrameFooter className="flex items-center justify-between p-2">
						<span className="text-[11px] tabular-nums text-muted-foreground">
							{total === 0
								? "0"
								: `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)}`}{" "}
							of {total}
						</span>
						<div className="flex items-center gap-1">
							<Button
								size="sm"
								variant="outline"
								disabled={page === 0 || loading}
								onClick={() => setPageIndex(page - 1)}
								aria-label="Previous page"
							>
								<ChevronLeft className="size-4" />
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={page >= pageCount - 1 || loading}
								onClick={() => setPageIndex(page + 1)}
								aria-label="Next page"
							>
								<ChevronRight className="size-4" />
							</Button>
						</div>
					</FrameFooter>
				</>
			) : null}
		</Frame>
	);
}

function SortableHead({
	label,
	active,
	onClick,
}: {
	label: string;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<TableHead className="w-[18%] text-right">
			<button
				type="button"
				onClick={onClick}
				className="ml-auto flex items-center gap-1 rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/30"
			>
				{label}
				{active ? (
					<ChevronDown className="size-3.5" />
				) : (
					<ChevronUp className="size-3.5 opacity-30" />
				)}
			</button>
		</TableHead>
	);
}

function lastActive(row: UsageGroup): string {
	const date = row.endedAt ?? row.startedAt;
	return date === null
		? "Last active unavailable"
		: `Last active ${date.toLocaleDateString()}`;
}
