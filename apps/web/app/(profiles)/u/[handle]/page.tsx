import { DitherAvatar, DitherWaveBackground } from "@repo/ui/dither";
import { IconBrandGithub } from "@tabler/icons-react";
import { usageProfileActivity } from "@zuse/utils/usage-profile";
import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { Button } from "@/components/button";
import { getPublicUsageProfile } from "@/lib/usage-profile";
import { cn } from "@/lib/utils";
import {
	compact,
	DitherColumns,
	duration,
	GUTTER,
	MONTHS,
	Panel,
	PanelRow,
	percent,
	rankFill,
	ShareBreakdown,
	StatStrip,
	usd,
	utcDate,
} from "./profile-ui";
import { ShareProfile } from "./share-profile";
import "./profile.css";

export const dynamic = "force-dynamic";

const WEEKDAYS = [
	"Sundays",
	"Mondays",
	"Tuesdays",
	"Wednesdays",
	"Thursdays",
	"Fridays",
	"Saturdays",
];
const WEEKDAY_ROWS = ["", "Mon", "", "Wed", "", "Fri", ""];
const OTHER_MODELS = "Other models";

/** 0 is an empty day; 1–4 are intensity steps relative to the busiest day. */
const level = (tokens: number, max: number) => {
	if (tokens <= 0) return 0;
	const ratio = tokens / max;
	return ratio < 0.15 ? 1 : ratio < 0.4 ? 2 : ratio < 0.7 ? 3 : 4;
};

const topWithRemainder = (
	rows: ReadonlyArray<{ name: string; tokens: number }>,
	limit: number,
) => {
	const sorted = rows
		.filter((row) => row.tokens > 0)
		.sort((a, b) => b.tokens - a.tokens);
	const top = sorted
		.slice(0, limit)
		.map((row) => ({ ...row, key: `row:${row.name}` }));
	const rest = sorted.slice(limit).reduce((sum, row) => sum + row.tokens, 0);
	if (rest > 0)
		top.push({ name: OTHER_MODELS, tokens: rest, key: "remainder" });
	return top;
};

type Props = { params: Promise<{ handle: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
	const { handle } = await params;
	const profile = await getPublicUsageProfile(handle);
	return {
		title: profile
			? `${profile.displayName} (@${profile.handle}) · Zuse`
			: "Profile unavailable · Zuse",
		robots: { index: false, follow: false },
		referrer: "no-referrer",
	};
}

export default async function UsageProfilePage({ params }: Props) {
	const { handle } = await params;
	const profile = await getPublicUsageProfile(handle);
	if (!profile) notFound();
	const stats = usageProfileActivity(profile);
	const total = stats.totalTokens;
	const coveredDays = stats.days.filter((day) => day.covered);
	const activeDays = coveredDays.filter((day) => day.tokens > 0);
	const maxDay = Math.max(1, ...coveredDays.map((day) => day.tokens));
	const peakDay = activeDays.reduce<(typeof activeDays)[number] | null>(
		(best, day) => (!best || day.tokens > best.tokens ? day : best),
		null,
	);

	const weekdayTotals = Array.from({ length: 7 }, () => ({
		tokens: 0,
		days: 0,
	}));
	for (const day of coveredDays) {
		const slot = weekdayTotals[new Date(`${day.date}T00:00:00Z`).getUTCDay()];
		if (!slot) continue;
		slot.tokens += day.tokens;
		slot.days += 1;
	}
	const weekdayAverages = weekdayTotals.map((slot) =>
		slot.days ? slot.tokens / slot.days : 0,
	);
	const busiestWeekday = weekdayAverages.indexOf(Math.max(...weekdayAverages));

	const monthTotals = MONTHS.map((_, index) =>
		coveredDays
			.filter((day) => Number(day.date.slice(5, 7)) === index + 1)
			.reduce((sum, day) => sum + day.tokens, 0),
	);
	const bestMonth = monthTotals.indexOf(Math.max(...monthTotals));
	const generatedMonth = Number(profile.generatedAt.slice(5, 7));

	const models = topWithRemainder(profile.models, 5);
	const modelRank = new Map(
		models.map((model, index) => [model.name, index] as const),
	);
	const tools = profile.sources
		.filter((source) => source.tokens > 0)
		.map((source) => ({
			key: source.id,
			name: source.label,
			tokens: source.tokens,
		}));

	const weekCount = Math.ceil((stats.offset + stats.days.length) / 7);
	const weeks = Array.from({ length: weekCount }, (_, index) => {
		const days = stats.days.slice(
			Math.max(0, index * 7 - stats.offset),
			(index + 1) * 7 - stats.offset,
		);
		return {
			key: `week-${index}`,
			value: days.reduce((sum, day) => sum + day.tokens, 0),
			muted: !days.some((day) => day.covered),
		};
	});
	const columns = {
		gridTemplateColumns: `repeat(${weekCount}, minmax(0, 1fr))`,
	};

	const { breakdown } = profile;
	const promptTokens =
		breakdown.input + breakdown.cacheRead + breakdown.cacheWrite;
	const cacheHitRate = promptTokens ? breakdown.cacheRead / promptTokens : 0;
	const tokenTypes = [
		{ key: "cache-read", name: "Cache reads", tokens: breakdown.cacheRead },
		{ key: "input", name: "Input", tokens: breakdown.input },
		{ key: "cache-write", name: "Cache writes", tokens: breakdown.cacheWrite },
		{ key: "output", name: "Output", tokens: breakdown.output },
		{ key: "reasoning", name: "Reasoning", tokens: breakdown.reasoning },
	]
		.filter((row) => row.tokens > 0)
		.sort((a, b) => b.tokens - a.tokens);

	const hours = profile.hours;
	const peakHour = hours ? hours.indexOf(Math.max(...hours)) : -1;
	const monthMix = new Map(
		profile.months.map((row) => [row.month, row.models]),
	);
	const maxMonth = Math.max(1, ...monthTotals);

	return (
		<article className="pb-24">
			<header className="page-masthead">
				<Image
					src="/brand/observatory-dither.webp"
					alt=""
					width={480}
					height={480}
					sizes="464px"
					className="masthead-art"
					priority
				/>
				<div className="relative z-10">
					<div className="flex items-center gap-3">
						<DitherAvatar name={profile.handle} hue={78} size={28} animate />
						<p className="editorial-label font-mono">
							Usage profile · {profile.year}
						</p>
					</div>
					<h1 className="mt-7 max-w-4xl break-words text-[clamp(2.75rem,7vw,5.5rem)]">
						{profile.displayName}
					</h1>
					<p className="brand-heading heading-accent mt-1 text-[clamp(2rem,5vw,3.75rem)] text-primary">
						{compact(total)} tokens in {profile.year}.
					</p>
					{profile.cost && (
						<p className="mt-4 font-mono text-sm text-muted-foreground">
							{profile.cost.complete ? "≈ " : "At least "}
							<span className="text-foreground">{usd(profile.cost.usd)}</span>{" "}
							at API list prices
						</p>
					)}
					<div className="mt-10 flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
						<ul className="flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-xs text-muted-foreground">
							<li className="text-foreground">@{profile.handle}</li>
							{profile.github && (
								<li>
									<a
										href={`https://github.com/${encodeURIComponent(profile.github)}`}
										rel="noopener noreferrer"
										target="_blank"
										className="flex min-h-8 items-center gap-1.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
									>
										<IconBrandGithub size={14} />
										{profile.github}
									</a>
								</li>
							)}
							<li>
								Published{" "}
								{utcDate(profile.publishedAt, {
									month: "short",
									day: "numeric",
									year: "numeric",
								})}
							</li>
						</ul>
						<ShareProfile />
					</div>
				</div>
			</header>

			<StatStrip
				label="Usage summary"
				stats={[
					{
						label: "Sessions",
						value: compact(profile.sessionCount),
						detail: `median ${duration(profile.sessionMinutes.median)}`,
					},
					{
						label: "Projects",
						value: compact(profile.projectCount),
						detail: `${tools.length} ${tools.length === 1 ? "tool" : "tools"}`,
					},
					{
						label: "Active days",
						value: stats.activeDays.toString(),
						detail: `of ${coveredDays.length} so far`,
					},
					{
						label: "Longest streak",
						value: `${stats.longestStreak}d`,
						detail: `current ${stats.currentStreak}d`,
					},
				]}
			/>

			<Panel
				id="activity-heading"
				title="Activity"
				className="border-b border-dotted border-border"
				meta={
					<>
						Jan 1 –{" "}
						{utcDate(profile.generatedAt, { month: "short", day: "numeric" })},{" "}
						{profile.year} · UTC
					</>
				}
			>
				<div className="-mx-1 overflow-x-auto px-1 pb-2">
					<div className="grid min-w-[680px] grid-cols-[2rem_1fr] gap-x-2">
						<span />
						<div
							className="mb-2 grid font-mono text-[10px] text-muted-foreground"
							style={columns}
							aria-hidden="true"
						>
							{MONTHS.map((month, index) => (
								<span
									key={month}
									style={{
										gridColumn: `${Math.floor(((Date.UTC(profile.year, index, 1) - Date.UTC(profile.year, 0, 1)) / 86_400_000 + stats.offset) / 7) + 1} / span 4`,
									}}
								>
									{month}
								</span>
							))}
						</div>
						<div
							className="grid grid-rows-7 gap-[3px] font-mono text-[10px] text-muted-foreground"
							aria-hidden="true"
						>
							{WEEKDAY_ROWS.map((day, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: fixed weekday rows
								<span key={index} className="flex items-center leading-none">
									{day}
								</span>
							))}
						</div>
						<div
							className="grid grid-flow-col grid-rows-7 gap-[3px]"
							style={columns}
						>
							{Array.from({ length: stats.offset }, (_, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: leading blank days
								<span key={`blank-${index}`} />
							))}
							{stats.days.map((day) => {
								const step = level(day.tokens, maxDay);
								return (
									<div
										key={day.date}
										title={`${day.date} · ${day.covered ? `${day.tokens.toLocaleString("en")} tokens` : "outside snapshot"}`}
										className={cn(
											"aspect-square rounded-[2px] [--dither-size:4px]",
											!day.covered
												? "bg-foreground/[0.025]"
												: step === 0
													? "bg-foreground/[0.07]"
													: step === 4
														? "bg-primary"
														: `dither dither-${step + 1} bg-primary`,
										)}
									/>
								);
							})}
						</div>
					</div>
				</div>
				<div
					className="mt-4 flex items-center justify-end gap-1.5 font-mono text-[10px] text-muted-foreground"
					aria-hidden="true"
				>
					Less
					<span className="size-3 rounded-[2px] bg-foreground/[0.07]" />
					{[2, 3, 4].map((step) => (
						<span
							key={step}
							className={`dither dither-${step} size-3 rounded-[2px] bg-primary [--dither-size:4px]`}
						/>
					))}
					<span className="size-3 rounded-[2px] bg-primary" />
					More
				</div>
				<details className="mt-2 font-mono text-xs text-muted-foreground">
					<summary className="w-fit cursor-pointer py-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
						Daily activity details
					</summary>
					<div className="mt-2 max-h-56 max-w-sm overflow-y-auto">
						<table className="w-full text-left tabular-nums">
							<caption className="sr-only">
								Daily token counts in UTC through{" "}
								{profile.generatedAt.slice(0, 10)}
							</caption>
							<thead>
								<tr className="text-foreground">
									<th scope="col" className="py-1 font-normal">
										Date (UTC)
									</th>
									<th scope="col" className="py-1 text-right font-normal">
										Tokens
									</th>
								</tr>
							</thead>
							<tbody>
								{coveredDays.map((day) => (
									<tr
										key={day.date}
										className="border-t border-dotted border-border"
									>
										<td className="py-1">{day.date}</td>
										<td className="py-1 text-right">
											{day.tokens.toLocaleString("en")}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</details>
			</Panel>

			{peakDay && (
				<StatStrip
					label="Highlights"
					stats={[
						{
							label: "Peak day",
							value: compact(peakDay.tokens),
							detail: utcDate(peakDay.date, { month: "short", day: "numeric" }),
						},
						{
							label: "Busiest weekday",
							value: WEEKDAYS[busiestWeekday]?.slice(0, 3) ?? "—",
							detail: `${compact(weekdayAverages[busiestWeekday] ?? 0)} on average`,
						},
						{
							label: "Best month",
							value: MONTHS[bestMonth] ?? "—",
							detail: `${compact(monthTotals[bestMonth] ?? 0)} tokens`,
						},
						{
							label: "Daily average",
							value: compact(total / Math.max(1, stats.activeDays)),
							detail: "per active day",
						},
					]}
				/>
			)}

			<PanelRow>
				<Panel
					id="models-heading"
					title="Models"
					meta={`${profile.models.length} used`}
				>
					{models.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No recorded token activity yet.
						</p>
					) : (
						<ShareBreakdown rows={models} total={total} />
					)}
				</Panel>
				<Panel
					id="tools-heading"
					title="Tools"
					meta={`${tools.length} ${tools.length === 1 ? "agent" : "agents"}`}
				>
					{tools.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No tools recorded yet.
						</p>
					) : (
						<ShareBreakdown rows={tools} total={total} />
					)}
				</Panel>
			</PanelRow>

			{profile.months.length > 0 && (
				<Panel
					id="mix-heading"
					title="Model mix by month"
					meta="Tokens per month by model · UTC"
					className="border-b border-dotted border-border"
				>
					<div
						className="flex h-56 items-end gap-2 sm:gap-3"
						aria-hidden="true"
					>
						{MONTHS.map((month, index) => {
							const mix = monthMix.get(index + 1) ?? [];
							const monthTotal = monthTotals[index] ?? 0;
							const ordered = [...mix].sort(
								(a, b) =>
									(modelRank.get(a.name) ?? models.length) -
									(modelRank.get(b.name) ?? models.length),
							);
							return (
								<div
									key={month}
									className="flex h-full flex-1 flex-col justify-end"
								>
									{monthTotal > 0 ? (
										<div
											className="flex flex-col-reverse gap-[2px]"
											style={{
												height: `${Math.max(3, (monthTotal / maxMonth) * 100)}%`,
											}}
										>
											{ordered.map((model) => (
												<span
													key={model.name}
													className={cn(
														"[--dither-size:4px]",
														rankFill(
															modelRank.get(model.name) ??
																modelRank.get(OTHER_MODELS) ??
																models.length,
														),
													)}
													style={{
														flexGrow: model.tokens,
														flexBasis: 0,
														minHeight: 2,
													}}
												/>
											))}
										</div>
									) : (
										<span
											className={cn(
												"h-[2px]",
												index + 1 > generatedMonth
													? "bg-foreground/[0.06]"
													: "bg-foreground/20",
											)}
										/>
									)}
								</div>
							);
						})}
					</div>
					<div className="mt-3 flex gap-2 font-mono text-[10px] text-muted-foreground sm:gap-3">
						{MONTHS.map((month) => (
							<span key={month} className="flex-1 text-center">
								<span className="sm:hidden">{month.slice(0, 1)}</span>
								<span className="hidden sm:inline">{month}</span>
							</span>
						))}
					</div>
					<ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
						{models.map((model, index) => (
							<li key={model.key} className="flex items-center gap-2">
								<span
									className={cn(
										"size-2.5 [--dither-size:4px]",
										rankFill(index),
									)}
									aria-hidden="true"
								/>
								{model.name}
							</li>
						))}
					</ul>
					<div className="sr-only">
						<table>
							<caption>Tokens by model for each month (UTC)</caption>
							<tbody>
								{profile.months.map((row) => (
									<tr key={row.month}>
										<th scope="row">{MONTHS[row.month - 1]}</th>
										<td>
											{row.models
												.map(
													(model) =>
														`${model.name}: ${model.tokens.toLocaleString("en")}`,
												)
												.join(", ")}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</Panel>
			)}

			{total > 0 && (
				<PanelRow>
					<Panel
						id="types-heading"
						title="Token types"
						meta={`${compact(total)} total`}
					>
						<p className="mb-8 flex items-baseline gap-3">
							<span className="brand-heading text-5xl font-light tabular-nums">
								{percent(cacheHitRate, 1)}
							</span>
							<span className="font-mono text-xs text-muted-foreground">
								of prompt tokens served from cache
							</span>
						</p>
						{tokenTypes.length > 0 && (
							<ShareBreakdown rows={tokenTypes} total={total} />
						)}
					</Panel>
					<Panel
						id="sessions-heading"
						title="Sessions"
						meta={`${compact(profile.sessionCount)} total`}
					>
						<dl className="grid grid-cols-2 gap-x-6 gap-y-8">
							{[
								{
									label: "Median length",
									value: duration(profile.sessionMinutes.median),
								},
								{
									label: "Longest",
									value: duration(profile.sessionMinutes.longest),
								},
								{
									label: "Per active day",
									value: (
										profile.sessionCount / Math.max(1, stats.activeDays)
									).toFixed(1),
								},
								{
									label: "Tokens per session",
									value: compact(total / Math.max(1, profile.sessionCount)),
								},
							].map((item) => (
								<div key={item.label}>
									<dt className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
										{item.label}
									</dt>
									<dd className="brand-heading mt-3 text-4xl font-light tabular-nums">
										{item.value}
									</dd>
								</div>
							))}
						</dl>
					</Panel>
				</PanelRow>
			)}

			<PanelRow>
				<Panel
					id="weeks-heading"
					title="Weekly rhythm"
					meta={`${stats.activeWeeks} active weeks`}
					className={cn("flex flex-col", !hours && "lg:col-span-2")}
				>
					<DitherColumns values={weeks} className="min-h-40 flex-1" />
					<div className="mt-3 flex justify-between font-mono text-[10px] text-muted-foreground">
						<span>Jan</span>
						<span>Dec</span>
					</div>
				</Panel>
				{hours && (
					<Panel
						id="hours-heading"
						title="Time of day"
						meta={`Peaks around ${String(peakHour).padStart(2, "0")}:00 · local time`}
						className="flex flex-col"
					>
						<DitherColumns
							values={hours.map((value, hour) => ({
								key: `hour-${hour}`,
								value,
							}))}
							className="min-h-40 flex-1"
						/>
						<div className="mt-3 flex justify-between font-mono text-[10px] text-muted-foreground">
							{["00", "06", "12", "18", "23"].map((hour) => (
								<span key={hour}>{hour}</span>
							))}
						</div>
					</Panel>
				)}
			</PanelRow>

			<section
				className={cn(
					GUTTER,
					"relative isolate overflow-hidden border-b border-dotted border-border py-16",
				)}
			>
				<DitherWaveBackground className="absolute inset-0 -z-10" />
				<p className="editorial-label font-mono">Zuse</p>
				<h2 className="mt-4 max-w-xl text-[clamp(2rem,4vw,3rem)]">
					Run agents in parallel.{" "}
					<span className="heading-accent text-primary">
						Publish your year.
					</span>
				</h2>
				<div className="mt-8">
					<Button />
				</div>
			</section>

			<footer
				className={cn(
					GUTTER,
					"max-w-3xl space-y-2 pt-8 font-mono text-[11px] leading-relaxed text-muted-foreground",
				)}
			>
				<p>
					Snapshot updated {utcDate(profile.updatedAt, { dateStyle: "medium" })}
					. Covers January 1–
					{utcDate(profile.generatedAt, { month: "long", day: "numeric" })},{" "}
					{profile.year} (UTC).
				</p>
				<p>
					Self-reported usage from one environment. Tokens include input,
					output, cache, and reasoning counts as recorded by connected tools.
					Streaks are measured within this year, as of the snapshot date.
					Sessions are usage sessions, not prompt counts; session length spans
					first to last activity.
					{profile.cost &&
						" Cost is an estimate at public API prices, not what was billed."}
					{hours && " Time of day uses the publisher's local time zone."}
				</p>
			</footer>
		</article>
	);
}
