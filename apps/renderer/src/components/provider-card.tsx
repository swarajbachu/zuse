import { HugeiconsIcon } from "@hugeicons/react";
import {
	AlertCircleIcon,
	CircleArrowUp01Icon,
	Copy01Icon,
	LinkSquare01Icon,
	Loading02Icon,
	Tick01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import {
	type AgentAvailability,
	MODELS_BY_PROVIDER,
	type ProviderId,
	type ProviderUpdateEvent,
	visibleModelsForProvider,
} from "@zuse/contracts";
import { Effect, Fiber, Stream } from "effect";
import { useEffect, useMemo, useRef, useState } from "react";

import { ApiKeyRow } from "~/components/api-key-row";
import { BlurredEmail } from "~/components/blurred-email";
import { OpencodeProviderManager } from "~/components/opencode-provider-manager";
import { ProviderIcon } from "~/components/provider-icons";
import { Button } from "~/components/ui/button";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { ShimmerText } from "~/components/ui/shimmer-text";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
	formatVersionLabel,
	getProviderSummary,
	PROVIDER_STATUS_STYLES,
} from "~/lib/provider-status";
import { getRpcClient } from "~/lib/rpc-client";
import {
	openExternal,
	supportsProviderLogin,
	useProviderLogin,
} from "~/lib/use-provider-login";
import { cn } from "~/lib/utils";
import {
	IDLE_PROVIDER_UPDATE_STATE,
	useProvidersStore,
} from "~/store/providers";
import { useSettingsStore } from "~/store/settings";

const PROVIDER_LABEL: Record<ProviderId, string> = {
	claude: "Claude Code",
	codex: "Codex",
	grok: "Grok",
	gemini: "Gemini",
	cursor: "Cursor",
	opencode: "OpenCode",
};

const INSTALL_HINT: Partial<Record<ProviderId, string>> = {
	claude: "npm i -g @anthropic-ai/claude-code",
	codex: "npm i -g @openai/codex",
	grok: "curl -fsSL https://x.ai/cli/install.sh | bash",
	gemini: "npm i -g @google/gemini-cli",
	opencode: "curl -fsSL https://opencode.ai/install | bash",
};

const LOGIN_HINT: Partial<Record<ProviderId, string>> = {
	claude: "claude /login",
	codex: "codex login",
	grok: "grok",
	gemini: "gemini /auth",
	opencode: "opencode auth login",
};

/**
 * Providers that have a known paid-plan requirement for full agent usage.
 * For Grok we now decode the `tier` claim from `~/.grok/auth.json` JWT:
 *   - tier >= 4 → authLabel = "Grok subscription" (positive, shows plan, toggle works)
 *   - lower / unknown → authLabel = "Requires SuperGrok or X Premium+" → violet nag + disabled
 * The frontend only forces the subscription alarm/disable when the label contains "Requires".
 */
const SUBSCRIPTION_INFO: Partial<
	Record<ProviderId, { readonly plan: string; readonly url: string }>
> = {
	grok: { plan: "SuperGrok or X Premium+", url: "https://x.ai/cli" },
	claude: {
		plan: "Claude Pro",
		url: "https://www.anthropic.com/pricing#claude-code",
	},
};

export function ProviderCard({
	providerId,
	availability,
	loading,
}: {
	providerId: ProviderId;
	availability: AgentAvailability | undefined;
	loading: boolean;
}) {
	const subscription = SUBSCRIPTION_INFO[providerId];
	const persistedEnabled =
		useSettingsStore((s) => s.providerEnabled[providerId]) ?? true;

	// For providers that have a known subscription gate (grok, cursor), we only
	// force-disable + show the violet alarm *when the server probe explicitly
	// tells us the requirement is unmet* (i.e. authLabel contains "Requires").
	// Once the user has a real login (auth.json with email/tier), the probe
	// returns clean "authenticated + authEmail" and we treat the card normally.
	// This removes the permanent "you still need to subscribe" lie for paying
	// Grok users while still protecting people on free tiers from silent 403s.
	const unmetSubscriptionRequirement =
		subscription !== undefined &&
		availability?.authLabel?.toLowerCase().includes("require") === true;

	const enabled = unmetSubscriptionRequirement ? false : persistedEnabled;
	const setProviderEnabled = useSettingsStore((s) => s.setProviderEnabled);
	const baseSummary = useMemo(
		() => getProviderSummary(availability, enabled, loading),
		[availability, enabled, loading],
	);
	// Only force the violet "subscription" status + "Requires ..." headline
	// when the backend probe says the plan requirement is still unmet.
	// For a user with a valid Grok login the card will now show the normal
	// emerald "Authenticated as <email>" (or "Authenticated") state.
	const summary = unmetSubscriptionRequirement
		? {
				...baseSummary,
				statusKey: "subscription" as const,
				headline: `Requires ${subscription!.plan}`,
				detail: null,
				authEmail: null,
			}
		: baseSummary;
	const styles = PROVIDER_STATUS_STYLES[summary.statusKey];
	const versionLabel = formatVersionLabel(availability?.cliVersion);
	const showUpgrade = enabled && availability?.cliVersionStatus === "outdated";
	// Hover-revealed one-click update affordance — independent of the blocking
	// SDK floor (`showUpgrade`). Shown for any installed provider that has an
	// update command, EXCEPT when we know it's already on the latest published
	// version (`"current"`). That means:
	//   - npm providers behind latest → shown (warning-styled "vX available")
	//   - npm providers on latest      → hidden
	//   - curl-installed CLIs with version "unknown" → shown so they
	//     are updatable even though we can't read a registry version
	const showUpdate =
		enabled &&
		providerId !== "cursor" &&
		!showUpgrade &&
		availability?.cliInstalled === true &&
		availability.updateCommand !== undefined &&
		availability.latestVersionStatus !== "current";

	return (
		<div
			className={cn(
				"group flex flex-col bg-card transition-colors first:rounded-t-xl last:rounded-b-xl",
				!enabled && !unmetSubscriptionRequirement && "opacity-70",
			)}
		>
			<div className="flex w-full items-center gap-3 px-3.5 py-3 text-left group-first:rounded-t-xl">
				<span className="flex size-7 shrink-0 items-center justify-center">
					<ProviderIcon providerId={providerId} className="size-5" />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex items-center gap-2">
						<span
							className={cn("size-1.5 shrink-0 rounded-full", styles.dot)}
							aria-hidden
						/>
						<span className="truncate text-sm font-medium text-foreground">
							{PROVIDER_LABEL[providerId]}
						</span>
						{versionLabel !== null && (
							<span className="shrink-0 font-mono text-[10px] text-muted-foreground">
								{versionLabel}
							</span>
						)}
						{showUpdate && (
							<UpdateAvailableButton
								providerId={providerId}
								displayName={PROVIDER_LABEL[providerId]}
								latestVersion={availability?.latestVersion}
								behind={availability?.latestVersionStatus === "behind"}
							/>
						)}
					</div>
					<div className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
						<span className="truncate">{summary.headline}</span>
						{summary.authEmail !== null && (
							<BlurredEmail email={summary.authEmail} />
						)}
						{summary.detail !== null && (
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
					}}
					aria-label={
						unmetSubscriptionRequirement
							? `${PROVIDER_LABEL[providerId]} requires a ${subscription!.plan} subscription`
							: `Enable ${PROVIDER_LABEL[providerId]}`
					}
					title={
						unmetSubscriptionRequirement
							? `Requires ${subscription!.plan} subscription`
							: undefined
					}
				/>
			</div>

			<div
				className={cn(
					"flex flex-col gap-4 border-t border-border/40 px-3.5 py-3 text-xs",
					!enabled && "pointer-events-none",
				)}
			>
				{showUpgrade && (
					<CodeRow
						label="Update CLI"
						command={
							availability?.cliUpgradeCommand ?? INSTALL_HINT[providerId] ?? ""
						}
					/>
				)}
				{providerId !== "cursor" &&
					availability !== undefined &&
					!availability.cliInstalled && (
						<CodeRow label="Install" command={INSTALL_HINT[providerId] ?? ""} />
					)}
				{availability?.cliInstalled &&
					availability.authStatus === "unauthenticated" &&
					supportsProviderLogin(providerId) && (
						<ProviderSignInRow providerId={providerId} />
					)}
				{availability?.cliInstalled &&
					availability.authStatus === "unauthenticated" &&
					!supportsProviderLogin(providerId) &&
					providerId !== "cursor" && (
						<CodeRow label="Sign in" command={LOGIN_HINT[providerId] ?? ""} />
					)}
				<SubscriptionRow providerId={providerId} availability={availability} />

				{providerId === "opencode" ? (
					// OpenCode fronts ~150 model providers; its card gets a dedicated
					// provider manager (connect catalog providers, add custom
					// OpenAI-compatible ones, pick which models show) instead of the
					// single-model defaults + one API key the other harnesses use.
					<OpencodeProviderManager />
				) : (
					<>
						<ModelDefault providerId={providerId} />
						<ModelVisibilitySettings providerId={providerId} />

						{providerId === "cursor" && (
							<div className="rounded-md border border-border/50 bg-background/45 px-3 py-2.5">
								<span className="text-[11px] font-medium text-foreground">
									Sandboxed with auto-review
								</span>
								<p className="mt-1 text-[11px] leading-snug text-muted-foreground">
									Local edits and commands run through the bundled SDK sandbox.
									Calls rejected by auto-review are blocked instead of
									prompting.
								</p>
							</div>
						)}

						<div className="flex flex-col gap-1.5">
							{providerId !== "cursor" && (
								<span className="text-[11px] font-medium text-muted-foreground">
									API key (optional)
								</span>
							)}
							<ApiKeyRow
								providerId={providerId}
								required={providerId === "cursor"}
							/>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function ModelDefault({ providerId }: { providerId: ProviderId }) {
	const value = useSettingsStore(
		(s) => s.defaultModelByProvider[providerId] ?? "",
	);
	const setDefaultModel = useSettingsStore((s) => s.setDefaultModel);
	const modelEnabledByProvider = useSettingsStore(
		(s) => s.modelEnabledByProvider,
	);
	const models = visibleModelsForProvider(providerId, modelEnabledByProvider, {
		includeModelId: value,
	});
	const items = useMemo(
		() => models.map((m) => ({ value: m.id, label: m.label })),
		[models],
	);
	if (models.length === 0) return null;
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[11px] font-medium text-muted-foreground">
				Default model
			</span>
			<Select
				value={value}
				onValueChange={(next) => setDefaultModel(providerId, next as string)}
				items={items}
			>
				<SelectTrigger size="sm">
					<SelectValue />
				</SelectTrigger>
				<SelectPopup>
					{models.map((m) => (
						<SelectItem key={m.id} value={m.id}>
							{m.label}
						</SelectItem>
					))}
				</SelectPopup>
			</Select>
		</div>
	);
}

function ModelVisibilitySettings({ providerId }: { providerId: ProviderId }) {
	const modelEnabledByProvider = useSettingsStore(
		(s) => s.modelEnabledByProvider,
	);
	const setModelEnabled = useSettingsStore((s) => s.setModelEnabled);
	const models = MODELS_BY_PROVIDER[providerId] ?? [];
	if (models.length <= 1) return null;

	const visibleCount = models.filter(
		(m) => modelEnabledByProvider[providerId]?.[m.id] !== false,
	).length;

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-baseline justify-between">
				<span className="text-[11px] font-medium text-muted-foreground">
					Models
				</span>
				<span className="text-[10px] text-muted-foreground/70">
					{visibleCount} shown
				</span>
			</div>
			<div className="overflow-hidden rounded-md border border-border/50 bg-background/45">
				{models.map((model) => {
					const checked =
						modelEnabledByProvider[providerId]?.[model.id] !== false;
					const onlyVisible = checked && visibleCount <= 1;
					return (
						<div
							key={model.id}
							className="flex min-h-9 items-center gap-2 border-b border-border/40 px-2.5 py-1.5 last:border-b-0"
						>
							<span className="min-w-0 flex-1 truncate text-xs text-foreground">
								{model.label}
							</span>
							{model.defaultVisible === false && (
								<span className="rounded bg-muted/70 px-1.5 py-px text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
									older
								</span>
							)}
							<Switch
								checked={checked}
								disabled={onlyVisible}
								onCheckedChange={(next) =>
									setModelEnabled(providerId, model.id, next)
								}
								aria-label={`${checked ? "Hide" : "Show"} ${model.label}`}
								title={
									onlyVisible
										? "At least one model must stay visible"
										: undefined
								}
							/>
						</div>
					);
				})}
			</div>
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
	const info = SUBSCRIPTION_INFO[providerId];
	if (info === undefined) return null;

	const unmet =
		availability?.authLabel?.toLowerCase().includes("require") === true;
	if (!unmet) return null;

	return (
		<div className="flex flex-col gap-1.5 rounded-md border border-violet-400/25 bg-violet-500/[0.06] px-3 py-2.5">
			<span className="text-[11px] font-medium text-violet-300">
				Requires {info.plan} subscription
			</span>
			<p className="text-[11px] leading-snug text-muted-foreground">
				Sessions will fail if your plan doesn&apos;t include {info.plan}.
				Subscribe (or confirm your existing plan) before using{" "}
				{PROVIDER_LABEL[providerId]}.
			</p>
			<div>
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						openExternal(info.url);
					}}
					className="inline-flex items-center gap-1 rounded border border-violet-400/40 bg-violet-500/10 px-2 py-1 text-[11px] font-medium text-violet-100 transition-colors hover:bg-violet-500/20"
				>
					Subscribe
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
 * Click → subscribe to `agent.startLogin`, which spawns
 * the provider's `login` subcommand server-side and streams progress. The
 * first `url` event opens the OAuth page in the OS browser; the terminal
 * `done` event triggers an availability refresh and (on success) collapses the
 * row. Cancel interrupts the stream, which closes the server-side scope and
 * SIGTERMs the child process. The whole state machine lives in
 * `useProviderLogin` so the inline auth ErrorBubble can reuse it verbatim.
 */
function ProviderSignInRow({ providerId }: { providerId: ProviderId }) {
	const refresh = useProvidersStore((s) => s.refresh);
	const { state, start, cancel } = useProviderLogin(providerId, {
		onSuccess: () => {
			void refresh();
		},
	});
	const label = PROVIDER_LABEL[providerId];
	const manualCommand = LOGIN_HINT[providerId] ?? "";

	if (state.kind === "success") {
		return (
			<div className="flex items-center gap-2 rounded-md border border-emerald-400/30 bg-emerald-500/[0.06] px-3 py-2 text-[11px] text-emerald-200">
				<ShimmerText as="span">Signed in. Refreshing…</ShimmerText>
			</div>
		);
	}

	if (state.kind === "waiting") {
		return (
			<div className="flex flex-col gap-2 rounded-md border border-border/50 bg-muted px-3 py-2.5 text-[11px]">
				<div className="flex items-center gap-2 text-muted-foreground">
					<HugeiconsIcon
						icon={Loading02Icon}
						className="size-3.5 animate-spin"
						aria-hidden
					/>
					<ShimmerText as="span">
						{state.url === null
							? `Starting ${label} sign-in…`
							: "Waiting for browser sign-in…"}
					</ShimmerText>
				</div>
				<div className="flex items-center gap-2">
					{state.url !== null && (
						<Button
							type="button"
							size="xs"
							variant="outline"
							onClick={(e) => {
								e.stopPropagation();
								openExternal(state.url!);
							}}
							className="h-6 px-2 text-[11px]"
						>
							<HugeiconsIcon
								icon={LinkSquare01Icon}
								className="mr-1 size-3"
								aria-hidden
							/>
							Open browser again
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
						className="h-6 px-2 text-[11px]"
					>
						Cancel
					</Button>
				</div>
			</div>
		);
	}

	if (state.kind === "failed") {
		return (
			<div className="flex flex-col gap-2">
				<div className="rounded-md border border-rose-400/30 bg-rose-500/[0.06] px-3 py-2 text-[11px] text-rose-200">
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
						className="h-6 px-2 text-[11px]"
					>
						Try again
					</Button>
				</div>
				<CodeRow label="Or run manually" command={manualCommand} />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[11px] font-medium text-muted-foreground">
				Sign in
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
					Sign in to {label}
				</Button>
				<span className="text-[10px] text-muted-foreground">
					or run <code className="font-mono">$ {manualCommand}</code>
				</span>
			</div>
		</div>
	);
}

/**
 * Subscribe to `agent.updateProvider`, which spawns the provider's update
 * command server-side and streams its output. On the terminal `done` event we
 * re-probe availability so the card reflects the new version. Interrupting the
 * fiber (unmount / cancel) closes the stream scope, which SIGTERMs the child.
 */
function useProviderUpdate(providerId: ProviderId) {
	const refresh = useProvidersStore((s) => s.refresh);
	const state = useProvidersStore(
		(s) => s.updateStateByProvider[providerId] ?? IDLE_PROVIDER_UPDATE_STATE,
	);
	const setProviderUpdateState = useProvidersStore(
		(s) => s.setProviderUpdateState,
	);
	const fiberRef = useRef<Fiber.Fiber<unknown, unknown> | null>(null);
	const resetTimerRef = useRef<number | null>(null);

	useEffect(
		() => () => {
			const fiber = fiberRef.current;
			if (fiber !== null) void Effect.runPromise(Fiber.interrupt(fiber));
			setProviderUpdateState(providerId, IDLE_PROVIDER_UPDATE_STATE);
			if (resetTimerRef.current !== null)
				window.clearTimeout(resetTimerRef.current);
		},
		[providerId, setProviderUpdateState],
	);

	const run = async () => {
		if (state.kind === "running") return;
		if (resetTimerRef.current !== null) {
			window.clearTimeout(resetTimerRef.current);
			resetTimerRef.current = null;
		}
		setProviderUpdateState(providerId, { kind: "running", line: null });
		let client: Awaited<ReturnType<typeof getRpcClient>>;
		try {
			client = await getRpcClient();
		} catch (err) {
			setProviderUpdateState(providerId, {
				kind: "failed",
				reason: err instanceof Error ? err.message : String(err),
			});
			return;
		}
		const fiber = Effect.runFork(
			Stream.runForEach(
				client["provider.update"]({ providerId }),
				(event: ProviderUpdateEvent) =>
					Effect.sync(() => {
						if (event._tag === "log") {
							setProviderUpdateState(providerId, {
								kind: "running",
								line: event.text,
							});
						} else if (event._tag === "done") {
							fiberRef.current = null;
							if (event.ok) {
								// Re-probe FIRST so the version label is fresh before we flip
								// the badge to "Updated" — otherwise the badge and the old
								// version show together for a beat. Stay on the spinner until
								// the probe lands.
								void refresh().finally(() => {
									setProviderUpdateState(providerId, { kind: "success" });
									// Re-probe hides the icon if now on latest; for
									// version-unknown CLIs (Grok) drop the "Updated" badge after
									// a moment so the control returns to idle.
									resetTimerRef.current = window.setTimeout(() => {
										setProviderUpdateState(
											providerId,
											IDLE_PROVIDER_UPDATE_STATE,
										);
										resetTimerRef.current = null;
									}, 4_000);
								});
							} else {
								setProviderUpdateState(providerId, {
									kind: "failed",
									reason: event.reason ?? "Update failed.",
								});
							}
						}
					}),
			).pipe(
				Effect.catch((err) =>
					Effect.sync(() => {
						fiberRef.current = null;
						setProviderUpdateState(providerId, {
							kind: "failed",
							reason: err instanceof Error ? err.message : String(err),
						});
					}),
				),
			),
		);
		fiberRef.current = fiber;
	};

	return { state, run };
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
	providerId,
	displayName,
	latestVersion,
	behind,
}: {
	readonly providerId: ProviderId;
	readonly displayName: string;
	readonly latestVersion: string | undefined;
	readonly behind: boolean;
}) {
	const { state, run } = useProviderUpdate(providerId);

	const idleLabel =
		behind && latestVersion !== undefined
			? `Update ${displayName} to v${latestVersion}`
			: `Update ${displayName} to the latest version`;
	const tooltip =
		state.kind === "running"
			? (state.line ?? "Updating…")
			: state.kind === "success"
				? "Updated"
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

	// While active (running/success/failed) the control stays visible; idle is
	// hover-revealed so it doesn't clutter up-to-date rows.
	const active = state.kind !== "idle";
	const badge =
		state.kind === "running"
			? "Updating…"
			: state.kind === "failed"
				? "Failed"
				: state.kind === "success"
					? "Updated"
					: null;

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						disabled={state.kind === "running"}
						onClick={(e) => {
							e.stopPropagation();
							void run();
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
	const [copied, setCopied] = useState(false);
	const onCopy = () => {
		void navigator.clipboard.writeText(command).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		});
	};
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[11px] font-medium text-muted-foreground">
				{label}
			</span>
			<div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/40 px-2.5 py-1.5 font-mono text-[11px]">
				<code className="flex-1 truncate text-foreground">$ {command}</code>
				<Button
					type="button"
					size="xs"
					variant="ghost"
					onClick={onCopy}
					className="h-6 shrink-0 px-2 text-[10px]"
				>
					<HugeiconsIcon
						icon={Copy01Icon}
						className="mr-1 size-3"
						aria-hidden
					/>
					{copied ? "Copied" : "Copy"}
				</Button>
			</div>
		</div>
	);
}
