import { providerDisplayName } from "~/lib/provider-labels";
import { CopyButton } from "./copy-button.tsx";
import { ProviderAccountsControls } from "./provider-accounts.tsx";
import "@zuse/i18n/english/providers";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AgentAvailability, ProviderId } from "@zuse/contracts";
import { RichMessage, useMessages as useUiMessages } from "@zuse/i18n/react";
import {
	Add01Icon,
	AlertCircleIcon,
	ArrowDown01Icon,
	CircleArrowUp01Icon,
	Delete02Icon,
	LinkSquare01Icon,
	Loading02Icon,
	Tick01Icon,
} from "@zuse/icons/solid-rounded";
import { useEffect, useId, useMemo, useState } from "react";
import { ApiKeyRow } from "~/components/api-key-row";
import { BlurredEmail } from "~/components/blurred-email";
import { OpencodeProviderManager } from "~/components/opencode-provider-manager";
import { ProviderIcon } from "~/components/provider-icons";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ShimmerText } from "~/components/ui/shimmer-text";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { INSTALL_HINT } from "~/lib/provider-setup";
import {
	canRunProviderUpdate,
	formatVersionLabel,
	getProviderSummary,
	PROVIDER_STATUS_STYLES,
} from "~/lib/provider-status";
import { useSettingsStore } from "~/lib/settings-client-bus.ts";
import {
	openExternal,
	supportsProviderLogin,
	useProviderLogin,
} from "~/lib/use-provider-login";
import { cn } from "~/lib/utils";
import { useProviderModels } from "~/store/model-catalog";
import { useProviderUpdate } from "~/store/providers";

const LOGIN_HINT: Partial<Record<ProviderId, string>> = {
	claude: "claude /login",
	codex: "codex login",
	grok: "grok login",
	gemini: "gemini /auth",
	opencode: "opencode auth login",
	opencode2: "opencode2 auth login",
	kiro: "kiro-cli login",
};

/** Providers with an explicitly reported paid-plan requirement. */
const SUBSCRIPTION_INFO: Partial<
	Record<ProviderId, { readonly plan: string; readonly url: string }>
> = {
	grok: { plan: "SuperGrok or X Premium+", url: "https://x.ai/cli" },
	claude: {
		plan: "Claude Pro",
		url: "https://www.anthropic.com/pricing#claude-code",
	},
};

/**
 * One provider in the settings list: a compact summary row (status, version,
 * update, enable switch) that expands in place to its setup, models, and keys.
 * Long-running work started here (CLI update, sign-in) is owned by shared
 * stores, so collapsing the row or leaving the page never loses its status.
 */
export function ProviderSettingsRow({
	environmentId,
	providerId,
	availability,
	loading,
	expanded,
	onExpandedChange,
}: {
	environmentId: string;
	providerId: ProviderId;
	availability: AgentAvailability | undefined;
	loading: boolean;
	expanded: boolean;
	onExpandedChange: (expanded: boolean) => void;
}) {
	const { message: uiMessage } = useUiMessages(["common", "providers"]);
	const detailsId = useId();

	const subscription = SUBSCRIPTION_INFO[providerId];
	const persistedEnabled =
		useSettingsStore((s) => s.providerEnabled[providerId]) ?? true;

	// Only an explicit provider verdict can gate access. Grok uses CLI login status.
	const unmetSubscriptionRequirement =
		subscription !== undefined &&
		availability?.authLabel?.toLowerCase().includes("require") === true;

	const enabled = unmetSubscriptionRequirement ? false : persistedEnabled;
	const setProviderEnabled = useSettingsStore((s) => s.setProviderEnabled);
	const baseSummary = useMemo(
		() => getProviderSummary(availability, enabled, loading),
		[availability, enabled, loading, uiMessage],
	);
	// Only force the violet "subscription" status + "Requires ..." headline
	// when the backend probe says the plan requirement is still unmet.
	const summary =
		unmetSubscriptionRequirement && subscription !== undefined
			? {
					...baseSummary,
					statusKey: "subscription" as const,
					headline: uiMessage("providers:provider_card_requires_subscription", {
						plan: subscription.plan,
					}),
					detail: null,
					authEmail: null,
				}
			: baseSummary;
	const styles = PROVIDER_STATUS_STYLES[summary.statusKey];
	const versionLabel = formatVersionLabel(availability?.cliVersion);
	const showUpgrade = enabled && availability?.cliVersionStatus === "outdated";
	// One-click update affordance, independent of the blocking SDK floor
	// (`showUpgrade`). Shown for any installed provider with an update command
	// unless it is known to be on the latest published version; curl-installed
	// CLIs (Grok, version "unknown") stay updatable.
	const showUpdate =
		enabled &&
		!showUpgrade &&
		availability !== undefined &&
		canRunProviderUpdate(availability) &&
		availability.latestVersionStatus !== "current";
	// Subscription-gated rows still open so the Subscribe call to action is reachable.
	const canExpand = enabled || unmetSubscriptionRequirement;
	const open = expanded && canExpand;
	const label = providerDisplayName(providerId);

	return (
		<div className="group flex flex-col">
			{/* biome-ignore lint/a11y/noStaticElementInteractions: pointer shortcut; the chevron button is the keyboard control. */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: pointer shortcut; the chevron button is the keyboard control. */}
			<div
				className={cn(
					"flex min-h-12 items-center gap-3 px-3 py-2 transition-colors",
					canExpand && "cursor-pointer hover:bg-muted/30",
				)}
				onClick={() => {
					if (canExpand) onExpandedChange(!open);
				}}
			>
				<span
					className={cn(
						"grid size-7 shrink-0 place-items-center rounded-md bg-muted/60",
						!enabled && "opacity-60",
					)}
				>
					<ProviderIcon providerId={providerId} className="size-4" />
				</span>
				<div
					className={cn(
						"flex min-w-0 flex-1 flex-col gap-0.5",
						!enabled && !unmetSubscriptionRequirement && "opacity-60",
					)}
				>
					<div className="flex min-w-0 items-center gap-1.5">
						<span className="truncate text-xs font-medium text-foreground">
							{label}
						</span>
						{versionLabel !== null && (
							<span className="shrink-0 font-mono text-[10px] text-muted-foreground">
								{versionLabel}
							</span>
						)}
						{showUpdate && (
							<UpdateAvailableButton
								environmentId={environmentId}
								providerId={providerId}
								displayName={label}
								latestVersion={availability?.latestVersion}
								behind={availability?.latestVersionStatus === "behind"}
							/>
						)}
					</div>
					<div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
						<span
							className={cn("size-1.5 shrink-0 rounded-full", styles.dot)}
							aria-hidden
						/>
						<span className="truncate">{summary.headline}</span>
						{summary.authEmail !== null && (
							<BlurredEmail email={summary.authEmail} />
						)}
						{summary.detail !== null && summary.detail !== summary.headline && (
							<span className="truncate">· {summary.detail}</span>
						)}
					</div>
				</div>
				<Switch
					checked={enabled}
					disabled={unmetSubscriptionRequirement}
					onClick={(e) => e.stopPropagation()}
					onCheckedChange={(value) => {
						if (unmetSubscriptionRequirement) return;
						setProviderEnabled(providerId, value);
						if (!value) onExpandedChange(false);
					}}
					aria-label={
						unmetSubscriptionRequirement
							? uiMessage("providers:provider_card_requires_a_subscription", {
									value1: String(label),
									plan: String(subscription?.plan),
								})
							: uiMessage("providers:provider_card_enable", {
									value1: String(label),
								})
					}
					title={
						unmetSubscriptionRequirement
							? uiMessage("providers:provider_card_requires_subscription", {
									plan: String(subscription?.plan),
								})
							: undefined
					}
				/>
				<Button
					type="button"
					size="icon-sm"
					variant="ghost"
					className="h-7 w-7 text-muted-foreground"
					disabled={!canExpand}
					aria-expanded={open}
					aria-controls={detailsId}
					aria-label={uiMessage("providers:provider_row_configure", {
						label,
					})}
					onClick={(e) => {
						e.stopPropagation();
						onExpandedChange(!open);
					}}
				>
					<HugeiconsIcon
						icon={ArrowDown01Icon}
						className={cn(
							"size-3.5 transition-transform motion-reduce:transition-none",
							open && "rotate-180",
						)}
						aria-hidden
					/>
				</Button>
			</div>

			{open && (
				<div
					id={detailsId}
					className="flex flex-col gap-4 px-3 pt-1 pb-4 pl-3 text-xs"
				>
					{showUpgrade && (
						<CodeRow
							label={uiMessage("providers:provider_card_update_cli")}
							command={
								availability?.cliUpgradeCommand ??
								INSTALL_HINT[providerId] ??
								""
							}
						/>
					)}
					{providerId !== "cursor" &&
						availability !== undefined &&
						!availability.cliInstalled && (
							<CodeRow
								label={uiMessage("providers:provider_card_install")}
								command={INSTALL_HINT[providerId] ?? ""}
							/>
						)}
					{availability?.cliInstalled &&
						availability.authStatus === "unauthenticated" &&
						supportsProviderLogin(providerId) && (
							<ProviderSignInRow
								providerId={providerId}
								environmentId={environmentId}
							/>
						)}
					{availability?.cliInstalled &&
						availability.authStatus === "unauthenticated" &&
						!supportsProviderLogin(providerId) &&
						providerId !== "cursor" && (
							<CodeRow
								label={uiMessage("common:signIn")}
								command={LOGIN_HINT[providerId] ?? ""}
							/>
						)}
					<SubscriptionRow
						providerId={providerId}
						availability={availability}
					/>
					{enabled && (
						<ProviderConfiguration
							providerId={providerId}
							environmentId={environmentId}
						/>
					)}
				</div>
			)}
		</div>
	);
}

function ProviderConfiguration({
	providerId,
	environmentId,
}: {
	providerId: ProviderId;
	environmentId: string;
}) {
	const { message: uiMessage } = useUiMessages(["common", "providers"]);

	if (providerId === "opencode" || providerId === "opencode2") {
		// OpenCode fronts many model providers; it gets a dedicated provider
		// manager (connect catalog providers, add custom OpenAI-compatible ones,
		// pick which models show) instead of the single-model defaults + one API
		// key the other harnesses use.
		return <OpencodeProviderManager channel={providerId} />;
	}
	return (
		<>
			{providerId === "pi" && (
				<div className="flex flex-col gap-1.5">
					<PiBinaryPath />
					<p className="text-[11px] text-muted-foreground">
						<RichMessage
							id="providers:pi_setup_hint"
							components={{ part0: <code />, part1: <code /> }}
						/>
					</p>
				</div>
			)}
			{(providerId === "claude" || providerId === "codex") && (
				<ProviderAccountsControls
					key={`${environmentId}:${providerId}`}
					providerId={providerId}
					environmentId={environmentId}
				/>
			)}
			<ModelVisibilitySettings providerId={providerId} />
			{providerId === "cursor" && (
				<div className="rounded-md bg-muted/40 px-3 py-2.5">
					<span className="text-[11px] font-medium text-foreground">
						{uiMessage("providers:provider_card_sandboxed_with_auto_review")}
					</span>
					<p className="mt-1 text-[11px] leading-snug text-muted-foreground">
						{uiMessage(
							"providers:provider_card_local_edits_and_commands_run_through_the_bundled_sdk_sandbox_calls_rej",
						)}
					</p>
				</div>
			)}
			{providerId !== "pi" && (
				<div className="flex flex-col gap-1.5">
					{providerId !== "cursor" && (
						<span className="text-[11px] font-medium text-muted-foreground">
							{uiMessage("providers:provider_card_api_key_optional")}
						</span>
					)}
					<ApiKeyRow
						providerId={providerId}
						required={providerId === "cursor"}
					/>
				</div>
			)}
		</>
	);
}

function ModelVisibilitySettings({ providerId }: { providerId: ProviderId }) {
	const { message: uiMessage } = useUiMessages(["common", "providers"]);

	const [customModelId, setCustomModelId] = useState("");
	const modelEnabledByProvider = useSettingsStore(
		(s) => s.modelEnabledByProvider,
	);
	const customModelIds = useSettingsStore(
		(s) => s.customModelIdsByProvider[providerId] ?? [],
	);
	const setModelEnabled = useSettingsStore((s) => s.setModelEnabled);
	const addCustomModelId = useSettingsStore((s) => s.addCustomModelId);
	const removeCustomModelId = useSettingsStore((s) => s.removeCustomModelId);
	const models = useProviderModels(providerId);
	const normalizedCustomModelId = customModelId.trim();
	const modelIdAlreadyExists =
		models.some((model) => model.id === normalizedCustomModelId) ||
		customModelIds.includes(normalizedCustomModelId);
	const canAddCustomModel =
		normalizedCustomModelId.length > 0 &&
		normalizedCustomModelId.length <= 200 &&
		!modelIdAlreadyExists;

	const visibleCount = models.filter(
		(m) => modelEnabledByProvider[providerId]?.[m.id] !== false,
	).length;

	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex items-baseline justify-between">
				<RichMessage
					id="providers:provider_card_models_shown_sentence"
					values={{ value: visibleCount + customModelIds.length }}
					components={{
						part0: (
							<span className="text-[11px] font-medium text-muted-foreground" />
						),
						part1: <span className="text-[10px] text-muted-foreground/70" />,
					}}
				/>
			</div>
			<div className="flex flex-col divide-y divide-border/40 overflow-hidden rounded-md bg-muted/30">
				{models.map((model) => {
					const checked =
						modelEnabledByProvider[providerId]?.[model.id] !== false;
					const onlyVisible =
						checked && visibleCount + customModelIds.length <= 1;
					return (
						<div key={model.id} className="flex h-7 items-center gap-2 px-2.5">
							<span className="min-w-0 flex-1 truncate text-xs text-foreground">
								{model.label}
							</span>
							<Switch
								checked={checked}
								disabled={onlyVisible}
								onCheckedChange={(next) =>
									setModelEnabled(providerId, model.id, next)
								}
								aria-label={`${checked ? "Hide" : "Show"} ${model.label}`}
								title={
									onlyVisible
										? uiMessage(
												"providers:provider_card_at_least_one_model_must_stay_visible",
											)
										: undefined
								}
							/>
						</div>
					);
				})}
				{customModelIds.map((modelId) => (
					<div key={modelId} className="flex h-7 items-center gap-2 px-2.5">
						<span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
							{modelId}
						</span>
						<span className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
							{uiMessage("providers:provider_card_custom")}
						</span>
						<Button
							size="icon-xs"
							variant="ghost"
							onClick={() => removeCustomModelId(providerId, modelId)}
							aria-label={uiMessage(
								"providers:provider_card_remove_custom_model",
								{ modelId: String(modelId) },
							)}
						>
							<HugeiconsIcon icon={Delete02Icon} className="size-3" />
						</Button>
					</div>
				))}
			</div>
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (!canAddCustomModel) return;
					addCustomModelId(providerId, normalizedCustomModelId);
					setCustomModelId("");
				}}
			>
				<Input
					className="h-7"
					value={customModelId}
					onChange={(event) => setCustomModelId(event.target.value)}
					placeholder={uiMessage("providers:provider_card_enter_a_model_id")}
					aria-label={uiMessage("providers:provider_card_custom_model_id", {
						value1: String(providerDisplayName(providerId)),
					})}
					aria-invalid={normalizedCustomModelId.length > 200 || undefined}
				/>
				<Button
					type="submit"
					size="sm"
					variant="settings"
					className="h-7"
					disabled={!canAddCustomModel}
				>
					<HugeiconsIcon icon={Add01Icon} className="size-3.5" />
					{uiMessage("common:add")}
				</Button>
			</form>
			<p className="text-[10px] leading-snug text-muted-foreground/70">
				{uiMessage(
					"providers:provider_card_custom_ids_are_passed_directly_to_sentence",
					{ value: providerDisplayName(providerId) },
				)}
			</p>
		</div>
	);
}

/**
 * Subscription / plan notice for providers that gate behind a paid tier
 * (Grok → SuperGrok or X Premium+, Cursor → Cursor Pro).
 *
 * - If the server probe reports an unmet requirement (authLabel contains
 *   "Requires"), we show the strong violet alarm box + Subscribe CTA.
 * - If the user has a successful login (clean authenticated + email from
 *   auth.json), we render nothing — the card already shows "Authenticated
 *   as <email>" and the toggle works. The plan gate is still real and will
 *   be reported by the ACP at runtime with a helpful error.
 */
function SubscriptionRow({
	providerId,
	availability,
}: {
	providerId: ProviderId;
	availability?: AgentAvailability;
}) {
	const { message: uiMessage } = useUiMessages(["common", "providers"]);

	const info = SUBSCRIPTION_INFO[providerId];
	if (info === undefined) return null;

	const unmet =
		availability?.authLabel?.toLowerCase().includes("require") === true;
	if (!unmet) return null;

	return (
		<div className="flex flex-col gap-1.5 rounded-md bg-alert-info-bg px-3 py-2.5">
			<span className="text-[11px] font-medium text-info">
				{uiMessage("providers:provider_card_requires_subscription_sentence", {
					value: info.plan,
				})}
			</span>
			<p className="text-[11px] leading-snug text-muted-foreground">
				{uiMessage(
					"providers:provider_card_sessions_will_fail_if_your_plan_doesn_apos_t_include_subscri_sentence",
					{
						value: info.plan,
						value2: providerDisplayName(providerId),
					},
				)}
			</p>
			<div>
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						openExternal(info.url);
					}}
					className="inline-flex h-7 items-center gap-1 rounded-md bg-info/10 px-2 text-[11px] font-medium text-info transition-colors hover:bg-info/20"
				>
					{uiMessage("providers:provider_card_subscribe")}
					<HugeiconsIcon
						icon={LinkSquare01Icon}
						className="size-3"
						aria-hidden
					/>
				</button>
			</div>
		</div>
	);
}

/**
 * One-click sign-in row for providers with a real in-app login handler.
 * Click → subscribe to `provider.startLogin`,
 * which spawns the provider's `login` subcommand server-side and streams
 * progress. The terminal `done` event triggers an availability refresh and
 * (on success) collapses the row. Cancel interrupts the stream, which closes
 * the server-side scope and SIGTERMs the child process. The whole state
 * machine lives in `useProviderLogin` so the composer sign-in tray can reuse
 * it verbatim.
 */
function ProviderSignInRow({
	providerId,
	environmentId,
}: {
	providerId: ProviderId;
	environmentId: string;
}) {
	const { message: uiMessage } = useUiMessages(["common", "providers"]);

	const { state, start, cancel } = useProviderLogin(providerId, {
		environmentId,
	});
	const label = providerDisplayName(providerId);
	const manualCommand = LOGIN_HINT[providerId] ?? "";

	if (state.kind === "success") {
		return (
			<div className="flex h-7 items-center gap-2 rounded-md bg-alert-success-bg px-2.5 text-[11px] text-success">
				<ShimmerText as="span">
					{uiMessage("providers:provider_card_signed_in_refreshing")}
				</ShimmerText>
			</div>
		);
	}

	if (state.kind === "waiting") {
		return (
			<div className="flex flex-col gap-1.5">
				<div className="flex h-7 items-center gap-2 rounded-md bg-muted/40 pr-0.5 pl-2.5 text-[11px]">
					<div className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
						<HugeiconsIcon
							icon={Loading02Icon}
							className="size-3.5 animate-spin motion-reduce:animate-none"
							aria-hidden
						/>
						<ShimmerText as="span" className="truncate">
							{state.url === null
								? uiMessage("providers:provider_card_starting_sign_in", {
										label: String(label),
									})
								: uiMessage(
										"providers:provider_card_waiting_for_browser_sign_in",
									)}
						</ShimmerText>
					</div>
					<div className="flex shrink-0 items-center gap-1">
						{state.url !== null && (
							<Button
								type="button"
								size="xs"
								variant="ghost"
								onClick={(e) => {
									e.stopPropagation();
									if (state.url !== null) openExternal(state.url);
								}}
								className="h-7 px-2 text-[11px]"
							>
								<HugeiconsIcon
									icon={LinkSquare01Icon}
									className="mr-1 size-3"
									aria-hidden
								/>
								{uiMessage("providers:provider_card_open_browser_again")}
							</Button>
						)}
						<Button
							type="button"
							size="xs"
							variant="ghost"
							onClick={(e) => {
								e.stopPropagation();
								cancel();
							}}
							className="h-7 px-2 text-[11px]"
						>
							{uiMessage("common:cancel")}
						</Button>
					</div>
				</div>
				{state.output && (
					<p className="whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
						{state.output}
					</p>
				)}
			</div>
		);
	}

	if (state.kind === "failed") {
		return (
			<div className="flex flex-col gap-2">
				<div className="rounded-md bg-alert-error-bg px-2.5 py-1.5 text-[11px] text-destructive">
					{state.reason}
				</div>

				<div className="flex items-center gap-2">
					<Button
						type="button"
						size="xs"
						variant="outline"
						onClick={(e) => {
							e.stopPropagation();
							void start();
						}}
						className="h-7 px-2 text-[11px]"
					>
						{uiMessage("providers:provider_card_try_again")}
					</Button>
				</div>
				<CodeRow
					label={uiMessage("providers:provider_card_or_run_manually")}
					command={manualCommand}
				/>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[11px] font-medium text-muted-foreground">
				{uiMessage("common:signIn")}
			</span>
			<div className="flex items-center gap-2">
				<Button
					type="button"
					size="xs"
					variant="default"
					onClick={(e) => {
						e.stopPropagation();
						void start();
					}}
					className="h-7 px-3 text-[11px]"
				>
					{uiMessage("providers:provider_card_sign_in_to_sentence", {
						label: label,
					})}
				</Button>
				<span className="text-[10px] text-muted-foreground">
					<RichMessage
						id="providers:provider_card_or_run_sentence"
						values={{ manualCommand: manualCommand }}
						components={{ part0: <code className="font-mono" /> }}
					/>
				</span>
			</div>
		</div>
	);
}

/**
 * Hover-revealed one-click update control shown next to the version label.
 * Clicking the icon **runs the update immediately in-app** (spawns the install
 * command server-side, streams progress) — for npm providers and curl-based
 * CLIs like Grok alike. No dialog: the icon itself is the status badge
 * (spinner → check / alert), with a tooltip carrying the detail / error.
 * `stopPropagation` keeps the click from toggling the card's expand.
 */
function UpdateAvailableButton({
	environmentId,
	providerId,
	displayName,
	latestVersion,
	behind,
}: {
	readonly environmentId: string;
	readonly providerId: ProviderId;
	readonly displayName: string;
	readonly latestVersion: string | undefined;
	readonly behind: boolean;
}) {
	const { state, run, cancel } = useProviderUpdate(environmentId, providerId);
	const { message: uiMessage } = useUiMessages(["providers", "common"]);

	const idleLabel =
		behind && latestVersion !== undefined
			? uiMessage("providers:update_to_version", {
					name: displayName,
					version: latestVersion,
				})
			: uiMessage("providers:update_to_latest", { name: displayName });
	const tooltip =
		state.kind === "running"
			? uiMessage("providers:cancel_update")
			: state.kind === "success"
				? uiMessage("providers:updated")
				: state.kind === "failed"
					? state.reason
					: idleLabel;

	// The icon doubles as the status badge.
	const { icon, tone } =
		state.kind === "running"
			? {
					icon: (
						<HugeiconsIcon
							icon={Loading02Icon}
							className="size-3.5 animate-spin"
							aria-hidden
						/>
					),
					tone: "text-muted-foreground",
				}
			: state.kind === "success"
				? {
						icon: (
							<HugeiconsIcon
								icon={Tick01Icon}
								className="size-3.5"
								aria-hidden
							/>
						),
						tone: "text-emerald-400",
					}
				: state.kind === "failed"
					? {
							icon: (
								<HugeiconsIcon
									icon={AlertCircleIcon}
									className="size-3.5"
									aria-hidden
								/>
							),
							tone: "text-rose-400",
						}
					: {
							icon: (
								<HugeiconsIcon
									icon={CircleArrowUp01Icon}
									className="size-3.5"
									aria-hidden
								/>
							),
							tone: behind ? "text-warning" : "text-muted-foreground",
						};

	// Active states and known newer versions stay visible; an unknown-version
	// CLI's idle control is hover-revealed so it doesn't clutter the row.
	const active = state.kind !== "idle" || behind;
	const badge =
		state.kind === "running"
			? uiMessage("providers:updating")
			: state.kind === "failed"
				? uiMessage("providers:update_failed")
				: state.kind === "success"
					? uiMessage("providers:updated")
					: behind && latestVersion !== undefined
						? `v${latestVersion}`
						: null;

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							if (state.kind === "running") cancel();
							else void run();
						}}
						aria-label={idleLabel}
						className={cn(
							"flex shrink-0 items-center gap-1 rounded px-1 transition-opacity hover:bg-muted/60 focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-default",
							tone,
							active ? "opacity-100" : "opacity-0",
						)}
					>
						{icon}
						{badge !== null && (
							<span className="text-[10px] font-medium">{badge}</span>
						)}
					</button>
				}
			/>
			<TooltipPopup side="bottom" className="max-w-72">
				{tooltip}
			</TooltipPopup>
		</Tooltip>
	);
}

function CodeRow({ label, command }: { label: string; command: string }) {
	const { message: uiMessage } = useUiMessages(["common", "providers"]);

	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[11px] font-medium text-muted-foreground">
				{label}
			</span>
			<div className="flex h-7 items-center gap-2 rounded-md bg-muted/40 pr-0.5 pl-2.5 font-mono text-[11px]">
				<code className="flex-1 truncate text-foreground">$ {command}</code>
				<CopyButton text={command} label={uiMessage("common:copy")} showLabel />
			</div>
		</div>
	);
}

function PiBinaryPath() {
	const { message: uiMessage } = useUiMessages(["providers"]);
	const inputId = useId();
	const saved = useSettingsStore((s) => s.providerBinaryPaths?.pi ?? "");
	const save = useSettingsStore((s) => s.setProviderBinaryPath);
	const [value, setValue] = useState(saved);
	useEffect(() => setValue(saved), [saved]);
	return (
		<label htmlFor={inputId} className="flex flex-col gap-1.5">
			<span className="text-[11px] font-medium text-muted-foreground">
				{uiMessage("providers:pi_binary_path")}
			</span>
			<Input
				id={inputId}
				className="h-7 rounded-md bg-muted/50 px-2 text-xs"
				aria-label={uiMessage("providers:pi_binary_path")}
				placeholder={uiMessage("providers:pi_binary_placeholder")}
				value={value}
				onChange={(event) => setValue(event.target.value)}
				onBlur={() => save("pi", value)}
			/>
			<span className="text-[11px] text-muted-foreground">
				{uiMessage("providers:pi_binary_help")}
			</span>
		</label>
	);
}
