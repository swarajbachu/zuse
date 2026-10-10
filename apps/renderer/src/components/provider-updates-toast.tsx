import "@zuse/i18n/english/chat";
import "@zuse/i18n/english/common";
import "@zuse/i18n/english/providers";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AgentAvailability, ProviderId } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { ArrowRight02Icon, Tick01Icon } from "@zuse/icons/solid-rounded";
import { X } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";

import { ProviderIcon } from "~/components/provider-icons";
import { Button } from "~/components/ui/button";
import { DitherActionButton } from "~/components/ui/dither-action-button";
import { overlaySurface } from "~/components/ui/overlay-surface";
import { Spinner } from "~/components/ui/spinner";
import { canRunProviderUpdate } from "~/lib/provider-status";
import { useSettingsStore } from "~/lib/settings-client-bus";
import { readStorageWithLegacy } from "~/lib/storage-keys";
import { cn } from "~/lib/utils";
import { useEnvironmentCatalogStore } from "~/store/environment-catalog";
import {
	IDLE_PROVIDER_UPDATE_STATE,
	providerUpdateKey,
	useProvidersStore,
	useProviderUpdate,
} from "~/store/providers";
import { useUiStore } from "~/store/ui";

// Persist dismissed update sets so we don't re-nag every launch. The key
// encodes the exact (provider, latestVersion) pairs, so dismissing "Codex
// v1.2.0 + Claude v1.0.5" stays hidden — but a newer release changes the key
// and the toast returns.
const STORAGE_KEY = "zuse.dismissedProviderUpdates";
const LEGACY_STORAGE_KEYS = ["memoize.dismissedProviderUpdates"] as const;

function loadDismissed(): Set<string> {
	try {
		const raw = readStorageWithLegacy(
			window.localStorage,
			STORAGE_KEY,
			LEGACY_STORAGE_KEYS,
		);
		if (raw === null) return new Set();
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed)
			? new Set(parsed.filter((x): x is string => typeof x === "string"))
			: new Set();
	} catch {
		return new Set();
	}
}

function persistDismissed(keys: ReadonlySet<string>): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]));
	} catch {
		// localStorage can be unavailable (private mode / strict CSP). The toast
		// simply re-appears next launch — non-fatal.
	}
}

/**
 * Bottom-right toast listing provider CLIs that have a newer published
 * release, one row per provider with its installed → latest version and an
 * in-app Update button (plus Update all). Update runs are owned by the
 * providers store, so they share state with the provider settings rows and
 * survive the toast closing. Providers Zuse cannot update in-app link to
 * provider settings instead.
 *
 * Styled to match `UpdateBanner` (the app-update toast); offset upward so the
 * two don't overlap when both are visible.
 */
export function ProviderUpdatesToast() {
	const { message: uiMessage } = useUiMessages(["chat"]);

	const enabled = useSettingsStore((s) => s.providerUpdateNotificationsEnabled);
	const providerEnabled = useSettingsStore((s) => s.providerEnabled);
	const availability = useProvidersStore((s) => s.availability);
	const updateStateByKey = useProvidersStore((s) => s.updateStateByKey);
	const updateProvider = useProvidersStore((s) => s.updateProvider);
	const environmentId = useEnvironmentCatalogStore(
		(s) => s.activeEnvironmentId,
	);
	const setView = useUiStore((s) => s.setView);
	const setSettingsSection = useUiStore((s) => s.setSettingsSection);
	const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() =>
		loadDismissed(),
	);
	// Providers updated from this toast stay listed (showing their result)
	// after the refreshed availability reports them as current.
	const [startedHere, setStartedHere] = useState<ReadonlySet<ProviderId>>(
		() => new Set(),
	);

	if (!enabled) return null;

	const updateStateOf = (providerId: ProviderId) =>
		updateStateByKey[providerUpdateKey(environmentId, providerId)] ??
		IDLE_PROVIDER_UPDATE_STATE;

	const candidates = availability.filter(
		(a) =>
			providerEnabled[a.providerId] !== false &&
			a.latestVersionStatus === "behind",
	);
	const notificationKey = candidates
		.map((a) => `${a.providerId}:${a.latestVersion ?? "?"}`)
		.sort()
		.join(",");
	const rows = availability.filter(
		(a) =>
			candidates.includes(a) ||
			(startedHere.has(a.providerId) &&
				updateStateOf(a.providerId).kind !== "idle"),
	);

	if (
		rows.length === 0 ||
		(notificationKey !== "" && dismissed.has(notificationKey))
	) {
		return null;
	}

	const recordDismissed = () => {
		setStartedHere(new Set());
		if (notificationKey === "") return;
		const next = new Set(dismissed);
		next.add(notificationKey);
		persistDismissed(next);
		setDismissed(next);
	};

	const onReview = () => {
		setView("settings");
		setSettingsSection({ kind: "providers" });
		recordDismissed();
	};

	const startUpdates = (providerIds: ReadonlyArray<ProviderId>) => {
		setStartedHere((current) => new Set([...current, ...providerIds]));
		for (const providerId of providerIds) {
			void updateProvider(environmentId, providerId);
		}
	};

	const pendingUpdates = rows
		.filter((a) => {
			const kind = updateStateOf(a.providerId).kind;
			return canRunProviderUpdate(a) && (kind === "idle" || kind === "failed");
		})
		.map((a) => a.providerId);

	// Portal to body so the toast escapes any ancestor with a backdrop-filter /
	// transform that would trap `position: fixed` (same reason as UpdateBanner).
	return createPortal(
		<div
			role="status"
			className={cn(
				"compact-notification fixed right-3 bottom-20 z-50 flex w-[320px] flex-col overflow-hidden",
				overlaySurface,
			)}
		>
			<div className="flex h-10 items-center gap-1 pr-2 pl-3">
				<span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
					{uiMessage("chat:provider_updates_toast_title")}
				</span>
				{pendingUpdates.length > 1 && (
					<Button
						size="xs"
						variant="ghost"
						className="text-muted-foreground hover:text-foreground"
						onClick={() => startUpdates(pendingUpdates)}
					>
						{uiMessage("chat:provider_updates_toast_update_all")}
					</Button>
				)}
				<Button
					size="icon-xs"
					variant="ghost"
					onClick={recordDismissed}
					className="text-muted-foreground hover:text-foreground"
					aria-label={uiMessage(
						"chat:provider_updates_toast_dismiss_provider_update_toast",
					)}
				>
					<X className="size-3.5" strokeWidth={1.8} />
				</Button>
			</div>

			<ul className="flex flex-col">
				{rows.map((a) => (
					<ProviderUpdateRow
						key={a.providerId}
						environmentId={environmentId}
						availability={a}
						onUpdate={() => startUpdates([a.providerId])}
						onReview={onReview}
					/>
				))}
			</ul>

			<p className="border-t border-border px-3 py-2 text-[11px] leading-snug text-muted-foreground">
				{uiMessage("chat:provider_updates_toast_hint")}
			</p>
		</div>,
		document.body,
	);
}

// Fixed width so the update, progress, and retry states never shift the row.
const UPDATE_BUTTON_CLASS = "h-6 w-14 px-0 text-[10px]";

function ProviderUpdateRow({
	environmentId,
	availability,
	onUpdate,
	onReview,
}: {
	readonly environmentId: string;
	readonly availability: AgentAvailability;
	readonly onUpdate: () => void;
	readonly onReview: () => void;
}) {
	const { message: uiMessage } = useUiMessages(["chat", "common", "providers"]);
	const { state, cancel } = useProviderUpdate(
		environmentId,
		availability.providerId,
	);
	const currentVersion = availability.cliVersion?.trim() || undefined;
	const latestVersion = availability.latestVersion;

	return (
		<li className="flex h-10 items-center gap-2.5 border-t border-border pr-2 pl-3">
			<ProviderIcon providerId={availability.providerId} className="size-4" />
			<span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
				{availability.displayName}
			</span>
			{state.kind !== "success" && latestVersion !== undefined && (
				<span className="flex shrink-0 items-center gap-1 font-mono text-[10px] text-muted-foreground">
					{currentVersion !== undefined && (
						<>
							<span>{currentVersion}</span>
							<HugeiconsIcon
								icon={ArrowRight02Icon}
								className="size-3"
								aria-hidden
							/>
						</>
					)}
					<span>{latestVersion}</span>
				</span>
			)}
			{state.kind === "success" ? (
				<span className="flex h-6 items-center gap-1 px-1 text-[10px] font-medium text-emerald-400">
					<HugeiconsIcon icon={Tick01Icon} className="size-3" aria-hidden />
					{uiMessage("providers:updated")}
				</span>
			) : state.kind === "running" ? (
				<DitherActionButton
					tone="secondary"
					aria-busy
					aria-label={uiMessage("providers:cancel_update")}
					title={uiMessage("providers:cancel_update")}
					className={UPDATE_BUTTON_CLASS}
					onClick={cancel}
				>
					<Spinner className="size-3.5" />
				</DitherActionButton>
			) : !canRunProviderUpdate(availability) ? (
				<DitherActionButton
					tone="secondary"
					className={UPDATE_BUTTON_CLASS}
					onClick={onReview}
				>
					{uiMessage("common:settings")}
				</DitherActionButton>
			) : (
				<DitherActionButton
					tone={state.kind === "failed" ? "secondary" : "primary"}
					title={state.kind === "failed" ? state.reason : undefined}
					className={UPDATE_BUTTON_CLASS}
					onClick={onUpdate}
				>
					{state.kind === "failed"
						? uiMessage("common:retry")
						: uiMessage("chat:provider_updates_toast_update")}
				</DitherActionButton>
			)}
		</li>
	);
}
