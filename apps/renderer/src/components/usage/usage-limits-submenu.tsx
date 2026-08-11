import { HugeiconsIcon } from "@hugeicons/react";
import { Analytics01Icon } from "@hugeicons-pro/core-solid-rounded";
import type {
	ProviderId,
	ProviderUsageLimits,
	UsageLimitWindow,
} from "@zuse/contracts";

import { PROVIDER_DISPLAY } from "~/lib/provider-status";
import { usagePace } from "~/lib/usage-pace";
import { formatRelativeTime } from "~/lib/use-relative-time";
import { useUiStore } from "~/store/ui";
import { useUsageStore } from "~/store/usage";
import { useUsageLimitsStore } from "~/store/usage-limits";
import { ProviderIcon } from "../provider-icons";
import {
	MenuItem,
	MenuSeparator,
	MenuSub,
	MenuSubPopup,
	MenuSubTrigger,
} from "../ui/menu";
import { resetLabel, resetsInLabel, StickMeter } from "./usage-meter";

const PROVIDERS: ReadonlyArray<ProviderId> = [
	"claude",
	"codex",
	"grok",
	"gemini",
	"kiro",
];
const WINDOW_ORDER = { session: 0, weekly: 1, model: 2, overall: 3 } as const;
const PLACEHOLDER_FETCHED_AT = new Date(0).toISOString();

const placeholder = (providerId: ProviderId): ProviderUsageLimits => ({
	providerId,
	planLabel: null,
	windows: [],
	creditsRemaining: null,
	fetchedAt: PLACEHOLDER_FETCHED_AT,
	source: "cache",
	unavailableReason: "no-credentials",
});

/** Compact absolute count for menu rows (e.g. 1479 → "1.5k"). */
const formatCredits = (value: number): string => {
	if (!Number.isFinite(value)) return "—";
	const abs = Math.abs(value);
	if (abs >= 10_000) return `${Math.round(value / 1000)}k`;
	if (abs >= 1000) {
		const k = value / 1000;
		return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
	}
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

/**
 * Derive used/limit from remaining credits + used%, when the API only
 * surfaces remaining + percent (Kiro credit windows).
 */
const creditUsage = (
	creditsRemaining: number | null,
	usedPercent: number | null | undefined,
): { used: number; limit: number; remaining: number } | null => {
	if (
		creditsRemaining === null ||
		usedPercent === null ||
		usedPercent === undefined ||
		!Number.isFinite(creditsRemaining) ||
		!Number.isFinite(usedPercent)
	) {
		return null;
	}
	const remaining = Math.max(0, creditsRemaining);
	const fractionUsed = Math.min(100, Math.max(0, usedPercent)) / 100;
	if (fractionUsed <= 0) {
		return { used: 0, limit: remaining, remaining };
	}
	// At 100% we only know remaining (usually 0); skip absolute used/limit.
	if (fractionUsed >= 1) return null;
	const limit = remaining / (1 - fractionUsed);
	if (!Number.isFinite(limit) || limit <= 0) return null;
	const used = Math.max(0, limit - remaining);
	return { used, limit, remaining };
};

const percentLeft = (usedPercent: number | null | undefined): number | null =>
	usedPercent === null || usedPercent === undefined
		? null
		: Math.max(0, Math.round(100 - usedPercent));

/** Right-side summary on the provider row (Grok-style "% left · reset"). */
const rowSummary = (
	provider: ProviderUsageLimits,
	summary: UsageLimitWindow | undefined,
): string | null => {
	if (summary === undefined && provider.creditsRemaining === null) return null;
	const left = percentLeft(summary?.usedPercent);
	const reset = summary ? resetLabel(summary.resetsAt) : null;
	const credits = creditUsage(
		provider.creditsRemaining,
		summary?.usedPercent ?? null,
	);

	const parts: string[] = [];
	if (credits !== null) {
		// Credit pools (Kiro): prefer absolute remaining so the row is actionable.
		parts.push(`${formatCredits(credits.remaining)} cr`);
		if (left !== null) parts.push(`${left}%`);
	} else if (left !== null) {
		parts.push(`${left}% left`);
	}
	if (reset) parts.push(reset);
	return parts.length > 0 ? parts.join(" · ") : null;
};

function WindowDetail({
	value,
	creditsRemaining,
}: {
	value: UsageLimitWindow;
	creditsRemaining: number | null;
}) {
	const left = percentLeft(value.usedPercent);
	const reset = resetsInLabel(value.resetsAt);
	const pace = usagePace(
		value.usedPercent,
		value.resetsAt,
		value.windowMinutes,
	);
	const credits = creditUsage(creditsRemaining, value.usedPercent);
	return (
		<div className="space-y-1.5 py-2">
			<div className="flex items-center justify-between gap-4 text-xs">
				<span className="font-medium">{value.label}</span>
				<span className="tabular-nums text-muted-foreground">
					{left === null ? "—" : `${left}% left`}
				</span>
			</div>
			<StickMeter
				percent={value.usedPercent}
				tone={(value.usedPercent ?? 0) >= 80 ? "warning" : "default"}
			/>
			{credits !== null ? (
				<div className="flex justify-between gap-4 text-[11px] text-muted-foreground tabular-nums">
					<span>
						{formatCredits(credits.used)} used ·{" "}
						{formatCredits(credits.remaining)} left
					</span>
					<span>{formatCredits(credits.limit)} total</span>
				</div>
			) : null}
			<div className="flex justify-between gap-4 text-[11px] text-muted-foreground">
				<span>{reset ? `Resets in ${reset}` : "Reset unavailable"}</span>
				{pace ? (
					<span
						className={
							pace.tone === "reserve" ? "text-emerald-500" : "text-amber-500"
						}
					>
						{pace.label}
					</span>
				) : null}
			</div>
		</div>
	);
}

function ProviderMenuItem({ providerId }: { providerId: ProviderId }) {
	const provider =
		useUsageLimitsStore((state) =>
			state.providers.find((item) => item.providerId === providerId),
		) ?? placeholder(providerId);
	const loading = useUsageLimitsStore((state) => state.loading);
	const waitingForInitialData =
		loading && provider.fetchedAt === PLACEHOLDER_FETCHED_AT;
	const summary = provider.windows
		.slice()
		.sort((a, b) => WINDOW_ORDER[a.scope] - WINDOW_ORDER[b.scope])[0];
	const summaryText = rowSummary(provider, summary);

	return (
		<MenuSub>
			<MenuSubTrigger disabled={waitingForInitialData}>
				<ProviderIcon providerId={providerId} className="size-3.5" />
				<span className="min-w-0 flex-1 truncate">
					{PROVIDER_DISPLAY[providerId]}
				</span>
				{summaryText !== null ? (
					<span className="max-w-[7.5rem] shrink-0 truncate text-right text-[11px] tabular-nums text-muted-foreground">
						{summaryText}
					</span>
				) : null}
			</MenuSubTrigger>
			<MenuSubPopup className="w-80">
				<div className="px-2 py-1.5">
					<div className="flex items-center gap-2 border-b pb-2">
						<ProviderIcon providerId={providerId} className="size-4" />
						<div>
							<div className="text-sm font-medium">
								{PROVIDER_DISPLAY[providerId]}
							</div>
							<div className="text-[11px] text-muted-foreground">
								{provider.planLabel ??
									(loading ? "Loading usage…" : "Usage limits")}
							</div>
						</div>
					</div>
					{provider.windows.length > 0 ? (
						[...provider.windows]
							.sort((a, b) => WINDOW_ORDER[a.scope] - WINDOW_ORDER[b.scope])
							.map((value) => (
								<WindowDetail
									key={value.id}
									value={value}
									creditsRemaining={provider.creditsRemaining}
								/>
							))
					) : (
						<div className="py-6 text-center text-xs text-muted-foreground">
							{loading
								? "Loading usage…"
								: provider.unavailableReason === "unsupported"
									? "Not available for this account"
									: provider.unavailableReason === "no-credentials"
										? "Sign in with kiro-cli login to see limits"
										: provider.unavailableReason === "expired"
											? "Session expired — run kiro-cli login"
											: provider.unavailableReason === "error"
												? "Could not load limits — try again"
												: "No usage data available"}
						</div>
					)}
					{provider.creditsRemaining !== null ? (
						<div className="border-t py-2 text-xs">
							<span className="text-muted-foreground">Credits remaining</span>
							<span className="float-right font-medium tabular-nums">
								{formatCredits(provider.creditsRemaining)}
							</span>
						</div>
					) : null}
					{provider.fetchedAt !== PLACEHOLDER_FETCHED_AT ? (
						<div className="border-t pt-1.5 text-[10px] text-muted-foreground">
							Updated {formatRelativeTime(provider.fetchedAt) ?? "just now"} ·{" "}
							{provider.source === "session-event"
								? "session"
								: provider.source === "api"
									? "live"
									: "cached"}
						</div>
					) : null}
				</div>
			</MenuSubPopup>
		</MenuSub>
	);
}

export function UsageLimitsMenuItems() {
	const openUsage = useUiStore((state) => state.openUsage);
	const prefetchUsage = useUsageStore((state) => state.prefetch);
	return (
		<>
			<MenuSeparator />
			{PROVIDERS.map((providerId) => (
				<ProviderMenuItem key={providerId} providerId={providerId} />
			))}
			<MenuItem
				onPointerEnter={() => void prefetchUsage(null)}
				onFocus={() => void prefetchUsage(null)}
				onClick={() => openUsage("global")}
			>
				<HugeiconsIcon icon={Analytics01Icon} />
				Full usage
			</MenuItem>
			<MenuSeparator />
		</>
	);
}
