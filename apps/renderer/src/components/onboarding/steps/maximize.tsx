import { HugeiconsIcon } from "@hugeicons/react";
import CircleArrowUp01Icon from "@hugeicons-pro/core-solid-rounded/CircleArrowUp01Icon";
import Loading02Icon from "@hugeicons-pro/core-solid-rounded/Loading02Icon";
import type { UsageReport } from "@zuse/contracts";
import { Effect } from "effect";
import { useEffect, useState } from "react";

import { formatTokens, formatUsd, totalTokens } from "~/lib/format-usage.ts";
import { getRpcClient } from "../../../lib/rpc-client.ts";
import { StepHeader } from "./shared.tsx";

/**
 * Monthly reference for the "token maxer" onboarding story. We do not know the
 * user's exact plan yet, so this mirrors the board's default stack: Claude Max
 * plus ChatGPT Pro. `apiValue` is API-equivalent monthly value heavy users can
 * pull from those flat fees as of mid-2026, illustrative and not guaranteed.
 */
const MONTHLY_STACK = {
	subscriptionCost: "$400",
	apiValue: "$11,500 to $15,000",
	plans: [
		{ name: "Claude Max", price: "$200/mo", potential: "$1,500 to $5,000/mo" },
		{ name: "ChatGPT Pro", price: "$200/mo", potential: "up to $10,000/mo" },
	],
} as const;

const currentMonthRange = () => {
	const now = new Date();
	const since = new Date(now.getFullYear(), now.getMonth(), 1);
	const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
	const until = new Date(nextMonth.getTime() - 1);
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	return { since, until, timezone };
};

/**
 * Onboarding hook step. Reads this month's global Tokenmaxer report (scanned
 * from local CLI logs) and frames the whole monthly picture: what a user pays,
 * what API-equivalent value they already used, and what the subscription stack
 * can potentially produce.
 */
export function MaximizeStep() {
	const [report, setReport] = useState<UsageReport | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		void getRpcClient()
			.then((client) =>
				Effect.runPromise(
					client["usage.report"]({
						bucket: "monthly",
						...currentMonthRange(),
					}),
				),
			)
			.then((nextReport) => {
				if (cancelled) return;
				setReport(nextReport);
				setLoading(false);
			})
			.catch(() => {
				if (cancelled) return;
				setReport(null);
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const summary = report?.summary ?? null;
	const tokens = summary !== null ? totalTokens(summary) : 0;
	const hasSpend = summary !== null && tokens > 0;
	const usedValue =
		summary !== null && summary.costUsd !== null
			? formatUsd(summary.costUsd)
			: "$0.00";
	const sources =
		report?.bySource
			.filter((s) => totalTokens(s) > 0)
			.map((s) => s.label)
			.slice(0, 6) ?? [];
	const sourceLine = sources.length > 0 ? ` across ${sources.join(" · ")}` : "";

	return (
		<div className="flex flex-col gap-8">
			<StepHeader
				title="Maximize this month"
				subtitle="See the subscription bill, the API value you already used, and the value still available from the plans you pay for."
			/>

			{loading ? (
				<SpendSkeleton />
			) : (
				<MonthlySnapshot
					usedValue={usedValue}
					tokens={tokens}
					sourceLine={sourceLine}
				/>
			)}

			<div className="flex flex-col gap-4 rounded-2xl bg-muted/50 p-5">
				<div className="flex items-start gap-3">
					<span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
						<HugeiconsIcon
							icon={CircleArrowUp01Icon}
							className="size-4"
							strokeWidth={1.75}
						/>
					</span>
					<div className="flex flex-col gap-1">
						<span className="text-[14px] font-semibold text-foreground">
							The gap is the opportunity
						</span>
						<p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
							You pay a fixed monthly subscription. The more agents you run in
							parallel, the more API-equivalent value you get from the same
							bill.
						</p>
					</div>
				</div>

				<div className="flex flex-col rounded-xl border border-border/60 bg-background/60">
					{MONTHLY_STACK.plans.map((p) => (
						<PlanRow key={p.name} {...p} />
					))}
				</div>

				{hasSpend ? (
					<p className="text-[10px] leading-snug text-muted-foreground/70">
						This month: {formatTokens(tokens)} tokens{sourceLine}.
					</p>
				) : (
					<p className="text-[10px] leading-snug text-muted-foreground/70">
						No local usage found for this month yet. Once you run agents, this
						screen shows the API value you have already used.
					</p>
				)}
			</div>
		</div>
	);
}

function MonthlySnapshot({
	usedValue,
	tokens,
	sourceLine,
}: {
	usedValue: string;
	tokens: number;
	sourceLine: string;
}) {
	return (
		<div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_15rem]">
			<div className="flex min-h-36 flex-col justify-between rounded-2xl border border-primary/10 bg-primary/[0.055] p-5">
				<div className="flex flex-col gap-1">
					<span className="text-[11px] font-medium uppercase tracking-[0.16em] text-primary/80">
						API value used this month
					</span>
					<span className="text-[12px] text-muted-foreground">
						From your local agent logs
					</span>
				</div>
				<div className="flex flex-col gap-1.5">
					<span className="text-4xl font-semibold leading-none tracking-tight tabular-nums text-primary">
						{usedValue}
					</span>
					<span className="text-[11px] leading-snug text-muted-foreground">
						{tokens > 0
							? `${formatTokens(tokens)} tokens${sourceLine}`
							: "No usage found yet"}
					</span>
				</div>
			</div>

			<div className="grid gap-3">
				<CompactMetric
					label="You pay"
					value={MONTHLY_STACK.subscriptionCost}
					detail="Claude Max + ChatGPT Pro"
				/>
				<CompactMetric
					label="Available ceiling"
					value={MONTHLY_STACK.apiValue}
					detail="API-equivalent monthly value"
				/>
			</div>
		</div>
	);
}

function CompactMetric({
	label,
	value,
	detail,
}: {
	label: string;
	value: string;
	detail: string;
}) {
	return (
		<div className="flex min-h-[4.5rem] flex-col justify-center gap-1 rounded-2xl bg-muted/50 px-4 py-3">
			<span className="text-[11px] font-medium text-muted-foreground">
				{label}
			</span>
			<span className="text-xl font-semibold leading-tight tracking-tight tabular-nums text-foreground">
				{value}
			</span>
			<span className="text-[10px] leading-snug text-muted-foreground">
				{detail}
			</span>
		</div>
	);
}

function PlanRow({
	name,
	price,
	potential,
}: {
	name: string;
	price: string;
	potential: string;
}) {
	return (
		<div className="flex items-center justify-between gap-3 border-t border-border/60 px-3 py-2.5 first:border-0">
			<span className="flex min-w-0 flex-col">
				<span className="truncate text-[12px] font-medium text-foreground">
					{name}
				</span>
				<span className="text-[11px] text-muted-foreground">{price}</span>
			</span>
			<span className="flex shrink-0 flex-col items-end">
				<span className="text-[13px] font-semibold tabular-nums text-primary">
					{potential}
				</span>
				<span className="text-[10px] text-muted-foreground">API value</span>
			</span>
		</div>
	);
}

function SpendSkeleton() {
	return (
		<div className="flex flex-col gap-4 rounded-2xl bg-muted/50 p-5">
			<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
				<HugeiconsIcon
					icon={Loading02Icon}
					className="size-3.5 animate-spin"
					aria-hidden
				/>
				Scanning this month&apos;s local agent logs...
			</div>
			<div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_15rem]">
				<div className="flex h-36 flex-col justify-between rounded-2xl bg-background/60 p-5">
					<div className="h-3 w-40 animate-pulse rounded bg-muted" />
					<div className="space-y-2">
						<div className="h-9 w-36 animate-pulse rounded bg-muted" />
						<div className="h-3 w-48 animate-pulse rounded bg-muted" />
					</div>
				</div>
				<div className="grid gap-3">
					{[0, 1].map((i) => (
						<div
							key={i}
							className="flex flex-col justify-center gap-2 rounded-2xl bg-background/60 px-4 py-3"
						>
							<div className="h-3 w-20 animate-pulse rounded bg-muted" />
							<div className="h-6 w-28 animate-pulse rounded bg-muted" />
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
