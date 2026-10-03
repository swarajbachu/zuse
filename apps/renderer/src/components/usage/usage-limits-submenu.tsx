import "@zuse/i18n/english/usage";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
	ProviderId,
	ProviderUsageLimits,
	UsageLimitWindow,
} from "@zuse/contracts";
import { RichMessage, useMessages as useUiMessages } from "@zuse/i18n/react";
import { Analytics01Icon } from "@zuse/icons/solid-rounded";

import { PROVIDER_DISPLAY } from "~/lib/provider-status";
import {
	boundedUsagePercent,
	creditUsage,
	formatCredits,
	percentLeft,
	usageLimitsUnavailableLabel,
} from "~/lib/usage-limits-display";
import { usagePace } from "~/lib/usage-pace";
import { formatRelativeTime } from "~/lib/use-relative-time";
import { useUiStore } from "~/store/ui";
import { useUsageStore } from "~/store/usage";
import { useUsageLimitsStore } from "~/store/usage-limits";
import { ProviderIcon } from "../provider-icons";
import {
	Menu,
	MenuItem,
	MenuPopup,
	MenuSeparator,
	MenuSub,
	MenuSubPopup,
	MenuSubTrigger,
	MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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

function WindowDetail({
	value,
	creditsRemaining,
}: {
	value: UsageLimitWindow;
	creditsRemaining: number | null;
}) {
	const { message: uiMessage } = useUiMessages(["usage"]);

	const used = boundedUsagePercent(value.usedPercent);
	const left = percentLeft(used);
	const reset = resetsInLabel(value.resetsAt);
	const pace = usagePace(used, value.resetsAt, value.windowMinutes);
	const credits = creditUsage(creditsRemaining, used);
	return (
		<div className="space-y-1.5 py-2">
			<div className="flex items-center justify-between gap-4 text-xs">
				<span className="font-medium">{value.label}</span>
				<span className="tabular-nums text-muted-foreground">
					{left === null
						? "—"
						: uiMessage("usage:usage_limits_submenu_left_2", {
								left: String(left),
							})}
				</span>
			</div>
			<StickMeter
				percent={left}
				tone={(used ?? 0) >= 80 ? "warning" : "default"}
			/>
			{credits !== null ? (
				<div className="flex justify-between gap-4 text-[11px] text-muted-foreground tabular-nums">
					<RichMessage
						id="usage:usage_limits_submenu_used_left_total_sentence"
						values={{
							value: formatCredits(credits.used),
							value2: formatCredits(credits.remaining),
							value3: formatCredits(credits.limit),
						}}
						components={{ part0: <span />, part1: <span /> }}
					/>
				</div>
			) : null}
			<div className="flex justify-between gap-4 text-[11px] text-muted-foreground">
				<span>
					{reset
						? uiMessage("usage:usage_limits_submenu_resets_in", {
								reset: String(reset),
							})
						: uiMessage("usage:usage_limits_submenu_reset_unavailable")}
				</span>
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
	const { message: uiMessage } = useUiMessages(["usage"]);

	const provider =
		useUsageLimitsStore((state) =>
			state.providers.find((item) => item.providerId === providerId),
		) ?? placeholder(providerId);
	const loading = useUsageLimitsStore((state) => state.loading);
	const error = useUsageLimitsStore((state) => state.error);
	const waitingForInitialData =
		loading && provider.fetchedAt === PLACEHOLDER_FETCHED_AT;
	const summary = provider.windows
		.slice()
		.sort((a, b) => WINDOW_ORDER[a.scope] - WINDOW_ORDER[b.scope])[0];
	const left = percentLeft(summary?.usedPercent);
	const reset = summary ? resetLabel(summary.resetsAt) : null;
	const credits = provider.creditsRemaining;
	const summaryText = [
		credits !== null && Number.isFinite(credits)
			? uiMessage("usage:usage_limits_menu_credits", {
					value: formatCredits(Math.max(0, credits)),
				})
			: left !== null
				? uiMessage("usage:usage_limits_submenu_left_2", { left: String(left) })
				: null,
		reset,
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<MenuSub>
			<MenuSubTrigger className="h-7" disabled={waitingForInitialData}>
				<ProviderIcon providerId={providerId} className="size-3.5" />
				<span className="min-w-0 flex-1 truncate">
					{PROVIDER_DISPLAY[providerId]}
				</span>
				{summaryText !== "" ? (
					<span className="max-w-[7.5rem] shrink-0 truncate text-right text-[11px] tabular-nums text-muted-foreground">
						{summaryText}
					</span>
				) : null}
			</MenuSubTrigger>
			<MenuSubPopup className="w-80 max-w-[calc(100vw-1rem)]">
				<div className="px-2 py-1.5">
					<div className="flex items-center gap-2 pb-2">
						<ProviderIcon providerId={providerId} className="size-4" />
						<div>
							<div className="text-sm font-medium">
								{PROVIDER_DISPLAY[providerId]}
							</div>
							<div className="text-[11px] text-muted-foreground">
								{provider.planLabel ??
									(loading
										? uiMessage("usage:usage_limits_submenu_loading_usage")
										: uiMessage("usage:usage_dashboard_usage_limits"))}
							</div>
						</div>
					</div>
					{provider.unavailableReason &&
					(provider.windows.length > 0 ||
						provider.creditsRemaining !== null) ? (
						<div role="status" className="pb-2 text-xs text-muted-foreground">
							{uiMessage("usage:usage_limits_menu_stale")}
						</div>
					) : null}
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
					) : provider.creditsRemaining === null ? (
						<div className="py-6 text-center text-xs text-muted-foreground">
							{loading
								? uiMessage("usage:usage_limits_submenu_loading_usage")
								: usageLimitsUnavailableLabel(
										providerId,
										error ? "error" : provider.unavailableReason,
									)}
						</div>
					) : null}
					{provider.creditsRemaining !== null ? (
						<div className="py-2 text-xs">
							<RichMessage
								id="usage:usage_limits_submenu_credits_remaining_sentence"
								values={{
									value: formatCredits(Math.max(0, provider.creditsRemaining)),
								}}
								components={{
									part0: <span className="text-muted-foreground" />,
									part1: (
										<span className="float-right font-medium tabular-nums" />
									),
								}}
							/>
						</div>
					) : null}
					{provider.fetchedAt !== PLACEHOLDER_FETCHED_AT ? (
						<div className="pt-1.5 text-[10px] text-muted-foreground">
							{uiMessage("usage:usage_limits_submenu_updated")}
							{formatRelativeTime(provider.fetchedAt) ??
								uiMessage("usage:usage_limits_submenu_just_now")}{" "}
							·{" "}
							{provider.source === "session-event"
								? uiMessage("usage:usage_limits_submenu_session")
								: provider.source === "api"
									? uiMessage("usage:usage_limits_submenu_live")
									: uiMessage("usage:usage_limits_submenu_cached")}
						</div>
					) : null}
				</div>
			</MenuSubPopup>
		</MenuSub>
	);
}

export function UsageLimitsMenuItems() {
	const { message: uiMessage } = useUiMessages(["usage"]);

	const loading = useUsageLimitsStore((state) => state.loading);
	const error = useUsageLimitsStore((state) => state.error);
	const hasReadings = useUsageLimitsStore(
		(state) => state.providers.length > 0,
	);
	const refresh = useUsageLimitsStore((state) => state.refresh);
	const openUsage = useUiStore((state) => state.openUsage);
	const prefetchUsage = useUsageStore((state) => state.prefetch);
	return (
		<>
			<div className="px-2 py-1 text-xs font-medium">
				{uiMessage("usage:usage_dashboard_usage_limits")}
			</div>
			{error ? (
				<div role="alert" className="px-2 py-1 text-xs text-muted-foreground">
					{uiMessage(
						hasReadings
							? "usage:usage_limits_menu_stale"
							: "usage:usage_limits_menu_failed",
					)}
				</div>
			) : null}
			{loading ? (
				<div role="status" className="px-2 py-1 text-xs text-muted-foreground">
					{uiMessage("usage:usage_limits_submenu_loading_usage")}
				</div>
			) : null}
			{PROVIDERS.map((providerId) => (
				<ProviderMenuItem key={providerId} providerId={providerId} />
			))}
			<MenuSeparator />
			<MenuItem
				className="h-7"
				disabled={loading}
				closeOnClick={false}
				onClick={() => void refresh(true)}
			>
				{uiMessage("usage:usage_dashboard_refresh_usage")}
			</MenuItem>
			<MenuItem
				className="h-7"
				onPointerEnter={() => void prefetchUsage(null)}
				onFocus={() => void prefetchUsage(null)}
				onClick={() => openUsage("global")}
			>
				<HugeiconsIcon icon={Analytics01Icon} />
				{uiMessage("usage:usage_limits_submenu_full_usage")}
			</MenuItem>
		</>
	);
}

export function UsageLimitsMenu() {
	const { message } = useUiMessages(["usage"]);
	const load = useUsageLimitsStore((state) => state.load);
	const label = message("usage:usage_dashboard_usage_limits");
	return (
		<Menu
			onOpenChange={(open) => {
				if (open) void load();
			}}
		>
			<Tooltip>
				<TooltipTrigger
					render={
						<MenuTrigger
							aria-label={label}
							onPointerEnter={() => void load()}
							onFocus={() => void load()}
							className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						/>
					}
				>
					<HugeiconsIcon icon={Analytics01Icon} className="size-4" />
				</TooltipTrigger>
				<TooltipPopup side="top">{label}</TooltipPopup>
			</Tooltip>
			<MenuPopup
				side="top"
				align="end"
				className="w-72 max-w-[calc(100vw-1rem)]"
			>
				<UsageLimitsMenuItems />
			</MenuPopup>
		</Menu>
	);
}
