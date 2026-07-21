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

function WindowDetail({ value }: { value: UsageLimitWindow }) {
	const left =
		value.usedPercent === null
			? null
			: Math.max(0, Math.round(100 - value.usedPercent));
	const reset = resetsInLabel(value.resetsAt);
	const pace = usagePace(
		value.usedPercent,
		value.resetsAt,
		value.windowMinutes,
	);
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
	const left =
		summary?.usedPercent === null || summary?.usedPercent === undefined
			? null
			: Math.max(0, Math.round(100 - summary.usedPercent));

	return (
		<MenuSub>
			<MenuSubTrigger disabled={waitingForInitialData}>
				<ProviderIcon providerId={providerId} className="size-3.5" />
				<span className="min-w-0 flex-1 truncate">
					{PROVIDER_DISPLAY[providerId]}
				</span>
				{summary ? (
					<span className="w-24 shrink-0 truncate text-right text-[11px] tabular-nums text-muted-foreground">
						{left ?? "—"}% left
						{resetLabel(summary.resetsAt)
							? ` · ${resetLabel(summary.resetsAt)}`
							: ""}
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
							.map((value) => <WindowDetail key={value.id} value={value} />)
					) : (
						<div className="py-6 text-center text-xs text-muted-foreground">
							{loading
								? "Loading usage…"
								: provider.unavailableReason === "unsupported"
									? "Not available for this account"
									: "No usage data available"}
						</div>
					)}
					{provider.creditsRemaining !== null ? (
						<div className="border-t py-2 text-xs">
							<span className="text-muted-foreground">Credits remaining</span>
							<span className="float-right font-medium tabular-nums">
								{provider.creditsRemaining}
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
