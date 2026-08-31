import type {
	EnvironmentId,
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

import { Area } from "~/components/dither-kit/area";
import { AreaChart } from "~/components/dither-kit/area-chart";
import { BlockLegend } from "~/components/dither-kit/block-legend";
import { Grid } from "~/components/dither-kit/grid";
import { Tooltip } from "~/components/dither-kit/tooltip";
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
import { Card } from "./ui/card.tsx";
import { Frame, FrameFooter, FrameHeader, FrameTitle } from "./ui/frame.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./ui/table.tsx";
import { resetLabel, StickMeter } from "./usage/usage-meter";

const CHART_SERIES = [
	{ key: "input", label: "Input", color: "blue" as const },
	{ key: "output", label: "Output", color: "green" as const },
	{ key: "cache", label: "Cache", color: "purple" as const },
	{ key: "reasoning", label: "Reasoning", color: "orange" as const },
] as const;

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
	environmentId,
	projectId,
	availableProjectId,
	scopeLabel,
}: {
	environmentId: EnvironmentId;
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
	const openUsage = useUiStore((state) => state.openUsage);

	useEffect(() => {
		void refresh(projectId);
		void refreshLimits(false);
	}, [projectId, refresh, refreshLimits]);

	const forceRefresh = () => {
		void Promise.all([
			refresh(projectId, { forceRefresh: true }),
			refreshLimits(true),
		]);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<header className="flex h-12 shrink-0 items-center border-b border-border px-5">
				<h1 className="text-sm font-medium">Usage</h1>
			</header>
			<div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 pt-5">
				<p className="text-xs text-muted-foreground">{scopeLabel}</p>
				<div className="flex shrink-0 items-center gap-2">
					<fieldset
						className="flex rounded-md bg-muted/55 p-0.5"
						aria-label="Usage scope"
					>
						<button
							type="button"
							onClick={() => openUsage("global")}
							className={cn(
								"h-6 rounded-[5px] px-2 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-foreground/30",
								projectId === null
									? "bg-background text-foreground shadow-sm"
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
								"h-6 rounded-[5px] px-2 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 disabled:opacity-50",
								projectId !== null
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
							aria-pressed={projectId !== null}
						>
							Current
						</button>
					</fieldset>
					<fieldset
						className="flex rounded-md bg-muted/55 p-0.5"
						aria-label="Usage period"
					>
						{PERIODS.map((item) => (
							<button
								key={item.value}
								type="button"
								onClick={() => void setPeriod(item.value, projectId)}
								className={cn(
									"h-6 rounded-[5px] px-2 text-[10px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-foreground/30",
									period === item.value
										? "bg-background text-foreground shadow-sm"
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
						className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/30"
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
			</div>

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
					environmentId={environmentId}
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
			<div className="grid h-72 gap-8 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
				<div className="space-y-5">
					<div className="h-9 w-40 rounded bg-muted/55" />
					{Array.from({ length: 4 }, (_, index) => (
						<div key={index} className="space-y-2">
							<div className="h-3 w-28 rounded bg-muted/45" />
							<div className="h-1.5 rounded-full bg-muted/45" />
						</div>
					))}
				</div>
				<div className="rounded-md bg-muted/20" />
			</div>
			<div className="grid h-24 grid-cols-2 gap-px border-y border-border bg-border lg:grid-cols-4">
				{Array.from({ length: 4 }, (_, index) => (
					<div key={index} className="bg-background p-4">
						<div className="h-3 w-20 rounded bg-muted/45" />
						<div className="mt-3 h-5 w-24 rounded bg-muted/55" />
					</div>
				))}
			</div>
			<div className="h-52 rounded-md bg-muted/20" />
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
	environmentId,
	report,
	refreshing,
	projectId,
	period,
	selectedRange,
	onSelectRange,
}: {
	environmentId: EnvironmentId;
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
			label: "Cache reads",
			value: formatTokens(summary.cacheReadTokens),
			hint: `${Math.round((summary.cacheReadTokens / Math.max(1, summary.inputTokens + summary.cacheReadTokens)) * 100)}% of observed input`,
			delta: metricDelta(
				summary.cacheReadTokens,
				previous?.cacheReadTokens ?? null,
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
				<UsageChart
					groups={report.groups}
					bySource={report.bySource}
					summary={report.summary}
					selectedRange={selectedRange}
					onSelectRange={onSelectRange}
				/>
				<Frame className="grid grid-cols-2 gap-1 lg:grid-cols-4">
					{metrics.map((metric) => (
						<Metric key={metric.label} {...metric} />
					))}
				</Frame>
				<LimitStrip />
				<Contributors
					bySource={report.bySource}
					byModel={report.byModel}
					byProject={report.byProject}
					previousBySource={report.previousBySource}
					previousByModel={report.previousByModel}
					previousByProject={report.previousByProject}
				/>
				<SessionsExplorer
					environmentId={environmentId}
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
		<Frame aria-labelledby="limits-title">
			<FrameHeader className="flex-row items-baseline justify-between px-3 py-2">
				<FrameTitle id="limits-title">Plan limits</FrameTitle>
				<span className="text-[11px] text-muted-foreground">
					Live provider allowance
				</span>
			</FrameHeader>
			<div className="grid gap-1 lg:grid-cols-2">
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
		</Frame>
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
		<Card className="flex min-h-20 flex-row items-center gap-3 p-3">
			<div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/45">
				<ProviderIcon providerId={providerId} className="size-4" />
			</div>
			<div className="min-w-0">
				<div className="text-xs font-medium">
					{PROVIDER_DISPLAY[providerId]}
				</div>
				<div className="mt-1 truncate text-[11px] text-muted-foreground">
					{message}
				</div>
			</div>
		</Card>
	);
}

function LimitCard({ provider }: { provider: ProviderUsageLimits }) {
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
	return (
		<Card className="flex min-h-20 flex-row items-center gap-3 p-3">
			<div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/45">
				<ProviderIcon providerId={provider.providerId} className="size-4" />
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center justify-between gap-3">
					<div className="min-w-0">
						<div className="truncate text-xs font-medium">
							{PROVIDER_DISPLAY[provider.providerId]}
						</div>
						<div className="truncate text-[10px] text-muted-foreground">
							{provider.planLabel ?? primary?.label ?? "Usage limits"}
						</div>
					</div>
					<div className="shrink-0 text-right">
						<div className="text-sm font-medium tabular-nums">
							{left == null
								? (provider.creditsRemaining?.toLocaleString(undefined, {
										maximumFractionDigits: 1,
									}) ?? "—")
								: `${left}% left`}
						</div>
						<div className="text-[10px] text-muted-foreground">
							{primary
								? (resetLabel(primary.resetsAt) ?? "No reset")
								: "credits"}
						</div>
					</div>
				</div>
				{primary ? (
					<div className="mt-2">
						<StickMeter
							percent={primary.usedPercent}
							tone={(primary.usedPercent ?? 0) >= 80 ? "warning" : "default"}
						/>
					</div>
				) : null}
				{pace ? (
					<div
						className={cn(
							"mt-1 text-[10px]",
							pace.tone === "reserve" ? "text-emerald-500" : "text-amber-500",
						)}
					>
						{pace.label}
					</div>
				) : null}
			</div>
		</Card>
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
		<Card className="min-h-24 p-4">
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
				className="mt-2 truncate text-xl font-medium tracking-tight tabular-nums"
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
		</Card>
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
	bySource,
	summary,
	selectedRange,
	onSelectRange,
}: {
	groups: ReadonlyArray<UsageGroup>;
	bySource: ReadonlyArray<UsageGroup>;
	summary: UsageOverview["summary"];
	selectedRange: UsageRange | null;
	onSelectRange: (range: UsageRange | null) => void;
}) {
	const [measure, setMeasure] = useState<ChartMeasure>("cost");
	const [hovered, setHovered] = useState<number | null>(null);
	const visible = useMemo(() => groups.slice(-90), [groups]);
	const chartData = useMemo(
		() =>
			visible.map((group) => ({
				label: group.label,
				input: group.inputTokens,
				output: group.outputTokens,
				cache: group.cacheReadTokens + group.cacheCreationTokens,
				reasoning: group.reasoningTokens,
				cost: group.costUsd ?? 0,
			})),
		[visible],
	);
	const detail = hovered === null ? null : visible[hovered];
	const chartConfig = useMemo(
		() =>
			measure === "cost"
				? { cost: { label: "Estimated cost", color: "blue" as const } }
				: Object.fromEntries(
						CHART_SERIES.map((series) => [
							series.key,
							{ label: series.label, color: series.color },
						]),
					),
		[measure],
	);
	const sourceRows = useMemo(
		() =>
			bySource
				.slice()
				.sort((a, b) =>
					measure === "cost"
						? (b.costUsd ?? 0) - (a.costUsd ?? 0)
						: totalTokens(b) - totalTokens(a),
				)
				.slice(0, 5),
		[bySource, measure],
	);
	const sourceTotal = Math.max(
		1,
		sourceRows.reduce(
			(sum, row) =>
				sum + (measure === "cost" ? (row.costUsd ?? 0) : totalTokens(row)),
			0,
		),
	);
	return (
		<Frame>
			<FrameHeader className="flex-row items-center justify-between gap-3 px-3 py-2">
				<div className="flex min-w-0 items-center gap-2">
					<FrameTitle>Daily usage</FrameTitle>
					{selectedRange ? (
						<button
							type="button"
							onClick={() => onSelectRange(null)}
							className="truncate rounded bg-muted px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
						>
							{selectedRange.label} · Clear
						</button>
					) : null}
				</div>
				<div className="flex shrink-0 rounded-md bg-muted/60 p-0.5">
					{(["tokens", "cost"] as const).map((value) => (
						<button
							key={value}
							type="button"
							onClick={() => setMeasure(value)}
							className={cn(
								"h-6 rounded-[5px] px-2.5 text-[10px] capitalize outline-none focus-visible:ring-2 focus-visible:ring-foreground/30",
								measure === value
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
							aria-pressed={measure === value}
						>
							{value}
						</button>
					))}
				</div>
			</FrameHeader>
			<div className="grid gap-1">
				<Card className="p-5">
					<div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:items-end">
						<div>
							<div className="flex items-center gap-2">
								<span className="size-1.5 rounded-sm bg-primary" />
								<span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
									{measure === "cost"
										? "Estimated API cost"
										: "Processed tokens"}
								</span>
							</div>
							<span className="mt-2 text-4xl font-semibold tracking-[-0.04em] tabular-nums">
								{measure === "cost"
									? formatUsd(summary.costUsd)
									: formatTokens(totalTokens(summary))}
							</span>
							<p className="mt-1 max-w-xs text-[11px] leading-relaxed text-muted-foreground">
								{measure === "cost"
									? "Estimated from local usage at published provider rates. Actual billing may vary."
									: `${summary.recordCount.toLocaleString()} locally observed usage records in this period.`}
							</p>
						</div>
						<div>
							<div className="mb-3 flex items-center justify-between gap-3 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
								<span>
									{measure === "cost" ? "Cost by source" : "Tokens by source"}
								</span>
								<span className="shrink-0 normal-case tracking-normal">
									{sourceRows.length} active{" "}
									{sourceRows.length === 1 ? "source" : "sources"}
								</span>
							</div>
							<div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
								{sourceRows.map((row) => {
									const value =
										measure === "cost" ? (row.costUsd ?? 0) : totalTokens(row);
									const share = (value / sourceTotal) * 100;
									return (
										<div key={row.key} className="min-w-0 space-y-1.5">
											<div className="flex items-baseline justify-between gap-3 text-xs">
												<span className="truncate text-muted-foreground">
													{row.label}
												</span>
												<span className="shrink-0 tabular-nums">
													{measure === "cost"
														? formatUsd(value)
														: formatTokens(value)}
												</span>
											</div>
											<div className="h-1 overflow-hidden rounded-full bg-muted">
												<div
													className="h-full rounded-full bg-foreground/70"
													style={{ width: `${share}%` }}
												/>
											</div>
										</div>
									);
								})}
							</div>
						</div>
					</div>
				</Card>
				<Card className="min-w-0 p-4">
					{visible.length === 0 ? (
						<div className="flex h-64 items-center justify-center border-y border-border text-sm text-muted-foreground">
							No usage in this period.
						</div>
					) : (
						<>
							<BlockLegend config={chartConfig} className="mb-3" />
							<div className="h-64 w-full">
								<AreaChart
									data={chartData}
									config={chartConfig}
									margins={{ left: 72 }}
									animate={false}
									bloom="off"
									onHoverChange={setHovered}
								>
									<Grid />
									<XAxis dataKey="label" maxTicks={7} />
									<YAxis
										tickCount={4}
										tickFormatter={
											measure === "cost" ? formatUsd : formatTokens
										}
									/>
									{measure === "cost" ? (
										<Area dataKey="cost" variant="gradient" />
									) : (
										CHART_SERIES.map((series, index) => (
											<Area
												key={series.key}
												dataKey={series.key}
												variant={index % 2 === 0 ? "gradient" : "dotted"}
											/>
										))
									)}
									<Tooltip
										labelKey="label"
										valueFormatter={(value) =>
											measure === "cost"
												? formatUsd(value)
												: formatTokens(value)
										}
									/>
								</AreaChart>
							</div>
							<div
								className="mt-2 flex h-10 items-center justify-between gap-3 border-t border-border px-1 text-[11px]"
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
										Hover the chart for a daily breakdown
									</span>
								)}
							</div>
						</>
					)}
				</Card>
			</div>
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
			<FrameHeader className="flex-row items-center justify-between px-3 py-2">
				<FrameTitle>Breakdown</FrameTitle>
				<div className="flex rounded-md bg-muted/60 p-0.5">
					{(["providers", "models", "projects"] as const).map((value) => (
						<button
							key={value}
							type="button"
							onClick={() => {
								setTab(value);
								setExpanded(false);
							}}
							className={cn(
								"h-6 rounded-[5px] px-2 text-[10px] capitalize outline-none focus-visible:ring-2 focus-visible:ring-foreground/30",
								tab === value
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground",
							)}
							aria-pressed={tab === value}
						>
							{value}
						</button>
					))}
				</div>
			</FrameHeader>
			<Card className="overflow-hidden">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>
								{tab === "providers"
									? "Provider"
									: tab === "models"
										? "Model"
										: "Project"}
							</TableHead>
							<TableHead>Share</TableHead>
							<TableHead className="text-right">Tokens</TableHead>
							<TableHead className="text-right">Cost</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{visible.length === 0 ? (
							<TableRow>
								<TableCell
									colSpan={4}
									className="h-16 text-center text-muted-foreground"
								>
									No contributors found.
								</TableCell>
							</TableRow>
						) : (
							visible.map((row) => {
								const share = (totalTokens(row) / total) * 100;
								const previous = previousRows.find(
									(item) => item.key === row.key,
								);
								const delta = metricDelta(
									totalTokens(row),
									previous ? totalTokens(previous) : null,
								);
								return (
									<TableRow key={row.key}>
										<TableCell
											className="max-w-0 truncate font-medium"
											title={row.label}
										>
											{row.label}
										</TableCell>
										<TableCell className="tabular-nums text-muted-foreground">
											{share.toFixed(1)}%{delta ? ` · ${delta}` : ""}
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatTokens(totalTokens(row))}
										</TableCell>
										<TableCell className="text-right tabular-nums text-muted-foreground">
											{formatUsd(row.costUsd)}
										</TableCell>
									</TableRow>
								);
							})
						)}
					</TableBody>
				</Table>
			</Card>
			{rows.length > 5 ? (
				<FrameFooter className="p-2 text-center">
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
	environmentId,
	projectId,
	period,
	sessionCount,
	selectedRange,
}: {
	environmentId: EnvironmentId;
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
		environmentId,
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
								className="h-7 w-full rounded-md border border-input bg-card pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/24"
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
							className="h-7 rounded-md border border-input bg-card px-2 text-xs text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/24"
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
