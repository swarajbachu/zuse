import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Shared formatting and layout pieces for the public usage profile. */
export const compact = (value: number) =>
	new Intl.NumberFormat("en", {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(value);
export const percent = (value: number, total: number) =>
	`${total ? ((value / total) * 100).toFixed(1) : "0.0"}%`;
export const utcDate = (
	value: number | string,
	options: Intl.DateTimeFormatOptions,
) => new Date(value).toLocaleDateString("en", { ...options, timeZone: "UTC" });
export const usd = (value: number) =>
	new Intl.NumberFormat("en", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 0,
	}).format(value);
export const duration = (minutes: number) => {
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
};

export const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];
export const GUTTER = "px-[clamp(1.25rem,5vw,4rem)]";

/** Dither density by rank, densest first; ranks past the palette use a muted fill. */
const RANK_DENSITY = [4, 3, 2, 1, 0];
export const rankFill = (rank: number) =>
	rank < RANK_DENSITY.length
		? `dither dither-${RANK_DENSITY[rank]} bg-primary`
		: "dither dither-2 bg-foreground/45";

export function Panel({
	id,
	title,
	meta,
	className,
	children,
}: {
	id: string;
	title: string;
	meta?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	return (
		<section aria-labelledby={id} className={cn(GUTTER, "py-12", className)}>
			<div className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
				<h2 id={id} className="editorial-label font-mono">
					{title}
				</h2>
				{meta && (
					<p className="font-mono text-xs text-muted-foreground">{meta}</p>
				)}
			</div>
			{children}
		</section>
	);
}

/** Two panels side by side on large screens, separated by dotted rules. */
export function PanelRow({ children }: { children: ReactNode }) {
	return (
		<div className="grid border-b border-dotted border-border lg:grid-cols-2 [&>*+*]:border-t [&>*+*]:border-dotted [&>*+*]:border-border lg:[&>*+*]:border-t-0 lg:[&>*+*]:border-l">
			{children}
		</div>
	);
}

export function StatStrip({
	label,
	stats,
}: {
	label: string;
	stats: ReadonlyArray<{ label: string; value: string; detail?: string }>;
}) {
	return (
		<section
			aria-label={label}
			className="grid grid-cols-2 border-b border-dotted border-border md:grid-cols-4"
		>
			{stats.map((stat, index) => (
				<div
					key={stat.label}
					className={cn(
						"min-w-0 px-[clamp(1.25rem,5vw,4rem)] py-8 md:px-8 md:first:pl-[clamp(1.25rem,5vw,4rem)]",
						index % 2 === 1 && "border-l border-dotted border-border",
						index > 1 && "border-t border-dotted border-border md:border-t-0",
						index === 2 && "md:border-l",
					)}
				>
					<p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
						{stat.label}
					</p>
					<p className="brand-heading mt-4 truncate text-4xl font-light tabular-nums sm:text-5xl">
						{stat.value}
					</p>
					{stat.detail && (
						<p className="mt-2 truncate font-mono text-xs text-muted-foreground">
							{stat.detail}
						</p>
					)}
				</div>
			))}
		</section>
	);
}

/** A dithered 100% bar with a ranked legend underneath. */
export function ShareBreakdown({
	rows,
	total,
}: {
	rows: ReadonlyArray<{ key: string; name: string; tokens: number }>;
	total: number;
}) {
	return (
		<>
			<div className="flex h-9 gap-[3px]" aria-hidden="true">
				{rows.map((row, index) => (
					<span
						key={row.key}
						className={cn("[--dither-size:4px]", rankFill(index))}
						style={{ flexGrow: row.tokens, flexBasis: 0, minWidth: 4 }}
					/>
				))}
			</div>
			<ol className="mt-6">
				{rows.map((row, index) => (
					<li
						key={row.key}
						className="grid grid-cols-[1.75rem_1fr_auto_4rem] items-center gap-3 border-t border-dotted border-border py-3 text-sm first:border-t-0"
					>
						<span
							className={cn("size-3 [--dither-size:4px]", rankFill(index))}
							aria-hidden="true"
						/>
						<span className="truncate">{row.name}</span>
						<span className="font-mono text-xs text-muted-foreground tabular-nums">
							{compact(row.tokens)}
						</span>
						<span className="text-right font-mono text-xs tabular-nums">
							{percent(row.tokens, total)}
						</span>
					</li>
				))}
			</ol>
		</>
	);
}

/** Bottom-anchored dithered columns with a solid cap; empty slots draw a baseline. */
export function DitherColumns({
	values,
	className,
}: {
	values: ReadonlyArray<{ key: string; value: number; muted?: boolean }>;
	className?: string;
}) {
	const max = Math.max(1, ...values.map((entry) => entry.value));
	return (
		<div
			className={cn("flex items-end gap-[2px]", className)}
			aria-hidden="true"
		>
			{values.map((entry) => {
				const ratio = entry.value / max;
				return (
					<div
						key={entry.key}
						className="flex h-full flex-1 flex-col justify-end"
					>
						{entry.value > 0 ? (
							<div
								className="flex flex-col"
								style={{ height: `${Math.max(4, ratio * 100)}%` }}
							>
								<span className="h-[2px] shrink-0 bg-primary" />
								<span
									className={`dither dither-${ratio < 0.4 ? 2 : ratio < 0.7 ? 3 : 4} flex-1 bg-primary [--dither-size:4px]`}
								/>
							</div>
						) : (
							<span
								className={cn(
									"h-[2px]",
									entry.muted ? "bg-foreground/[0.06]" : "bg-foreground/20",
								)}
							/>
						)}
					</div>
				);
			})}
		</div>
	);
}
