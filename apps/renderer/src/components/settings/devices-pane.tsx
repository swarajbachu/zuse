import "@zuse/i18n/english/settings";
import type {
	ApiLinkStatus,
	AuthTokenSummary,
	NetworkAccessState,
	TailnetShareState,
} from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { dispatchLocalDeviceCommand } from "../../lib/local-device-client-bus.ts";
import {
	openExternal,
	rendererPlatformCapabilities,
} from "../../lib/platform-capabilities.ts";
import type { PairingMethod } from "../../lib/remote-access.ts";
import { Button } from "../ui/button.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { CloudDeviceAccessCard } from "./cloud-device-access-card.tsx";
import {
	AccessConfirmDialogs,
	type AccessDialog,
} from "./remote-access/access-confirm-dialogs.tsx";
import { showError } from "./remote-access/access-errors.ts";
import { AccessMethodsCard } from "./remote-access/access-methods-card.tsx";
import { ConnectLinkCard } from "./remote-access/connect-link-card.tsx";
import { ConnectedDevicesCard } from "./remote-access/connected-devices-card.tsx";
import { UsingComputersCard } from "./remote-access/using-computers-card.tsx";

const DEFAULT_API_URL =
	(import.meta.env.VITE_ZUSE_API_URL as string | undefined) ??
	"https://api.zuse.sh";

/**
 * Remote-access settings data and mutations. Presentation is composed from
 * the same compact Frame/Card patterns as the rest of settings.
 */
export function DevicesPane() {
	const { message: uiMessage } = useUiMessages(["settings"]);
	const [status, setStatus] = useState<ApiLinkStatus | null>(null);
	const [network, setNetwork] = useState<NetworkAccessState | null>(null);
	const [tailnet, setTailnet] = useState<TailnetShareState | null>(null);
	const [tokens, setTokens] = useState<ReadonlyArray<AuthTokenSummary>>([]);
	const [loading, setLoading] = useState(true);
	const [unavailableMethods, setUnavailableMethods] = useState<
		readonly PairingMethod[]
	>([]);
	const refreshing = useRef(false);
	const refreshRevision = useRef(0);
	const [busy, setBusy] = useState(false);
	const [tailnetBusy, setTailnetBusy] = useState(false);
	const [pendingNetworkMode, setPendingNetworkMode] = useState<boolean | null>(
		null,
	);
	const [accessDialog, setAccessDialog] = useState<AccessDialog>(null);
	const actionInFlightRef = useRef(false);

	const refresh = useCallback(async () => {
		if (refreshing.current) return;
		refreshing.current = true;
		const revision = ++refreshRevision.current;
		try {
			const bridge = window.zuse ?? window.memoize;
			const [networkResult, tailnetResult, apiResult, tokenResult] =
				await Promise.allSettled([
					bridge?.network?.getAccessState() ?? Promise.resolve(null),
					bridge?.network?.getTailnetShareState() ?? Promise.resolve(null),
					dispatchLocalDeviceCommand<Record<string, never>, ApiLinkStatus>(
						"api.status",
						{},
					),
					dispatchLocalDeviceCommand<
						Record<string, never>,
						ReadonlyArray<AuthTokenSummary>
					>("pairing.listTokens", {}),
				]);
			if (revision !== refreshRevision.current) return;
			const unavailable: PairingMethod[] = [];
			if (networkResult.status === "rejected" || networkResult.value === null)
				unavailable.push("local");
			if (tailnetResult.status === "rejected" || tailnetResult.value === null)
				unavailable.push("tailscale");
			if (apiResult.status === "rejected") unavailable.push("account");
			setUnavailableMethods(unavailable);
			if (networkResult.status === "fulfilled") setNetwork(networkResult.value);
			if (tailnetResult.status === "fulfilled") setTailnet(tailnetResult.value);
			if (apiResult.status === "fulfilled") setStatus(apiResult.value);
			if (tokenResult.status === "fulfilled") setTokens(tokenResult.value);
			setLoading(false);
		} finally {
			refreshing.current = false;
		}
	}, []);

	useEffect(() => {
		void refresh().catch((cause) => {
			setLoading(false);
			showError("Could not load device access", cause);
		});
	}, [refresh]);

	useEffect(() => {
		if (busy || tailnetBusy) return;
		const timer = window.setInterval(() => {
			if (document.visibilityState === "visible") void refresh();
		}, 10000);
		return () => window.clearInterval(timer);
	}, [busy, tailnetBusy, refresh]);

	const updateNetwork = useCallback(async () => {
		if (pendingNetworkMode === null) return;
		const bridge = window.zuse ?? window.memoize;
		if (bridge?.network === undefined) {
			showError(
				"Network access is unavailable",
				new Error("Desktop bridge missing"),
			);
			return;
		}
		refreshRevision.current++;
		setBusy(true);
		try {
			setNetwork(await bridge.network.setAccessEnabled(pendingNetworkMode));
			setPendingNetworkMode(null);
			setBusy(false);
		} catch (cause) {
			showError("Could not update network access", cause);
			setBusy(false);
		}
	}, [pendingNetworkMode]);

	const updateTailnet = useCallback(
		async (enabled: boolean): Promise<TailnetShareState | null> => {
			const bridge = window.zuse ?? window.memoize;
			if (bridge?.network === undefined || tailnetBusy) return null;
			refreshRevision.current++;
			setTailnetBusy(true);
			try {
				const next = await bridge.network.setTailnetShareEnabled(enabled);
				setTailnet(next);
				if (
					next.availability === "approval-required" &&
					next.approvalUrl !== null
				) {
					void openExternal(next.approvalUrl);
					return next;
				}
				if (next.availability === "conflict") {
					return next;
				}
				if (next.availability !== "available" || next.enabled !== enabled) {
					throw new Error(
						next.detail ?? "Tailscale could not update private sharing.",
					);
				}
				return next;
			} catch (cause) {
				showError("Could not update Tailscale access", cause);
				return null;
			} finally {
				setTailnetBusy(false);
			}
		},
		[tailnetBusy],
	);

	const connectApi = useCallback(async (): Promise<boolean> => {
		if (actionInFlightRef.current) return false;
		actionInFlightRef.current = true;
		refreshRevision.current++;
		setBusy(true);
		try {
			setStatus(
				await dispatchLocalDeviceCommand<
					{ readonly apiUrl: string },
					ApiLinkStatus
				>("api.link", {
					apiUrl: DEFAULT_API_URL.trim().replace(/\/$/, ""),
				}),
			);
			return true;
		} catch (cause) {
			showError("Could not set up remote access", cause);
			return false;
		} finally {
			actionInFlightRef.current = false;
			setBusy(false);
		}
	}, []);

	const unlinkApi = useCallback(async (): Promise<boolean> => {
		if (actionInFlightRef.current) return false;
		actionInFlightRef.current = true;
		refreshRevision.current++;
		setBusy(true);
		try {
			await dispatchLocalDeviceCommand<Record<string, never>, unknown>(
				"api.unlink",
				{},
			);
			setStatus(null);
			return true;
		} catch (cause) {
			showError("Could not turn off remote access", cause);
			return false;
		} finally {
			actionInFlightRef.current = false;
			setBusy(false);
		}
	}, []);

	const confirmAccessChange = useCallback(async () => {
		if (accessDialog === null) return;
		if (
			accessDialog === "tailscale-enable" &&
			tailnet?.availability === "not-installed"
		) {
			await openExternal("https://tailscale.com/download");
			setAccessDialog(null);
			return;
		}
		const changed =
			accessDialog === "serve-enable"
				? await connectApi()
				: accessDialog === "serve-disable"
					? await unlinkApi()
					: (await updateTailnet(accessDialog === "tailscale-enable")) !== null;
		if (changed) setAccessDialog(null);
	}, [
		accessDialog,
		connectApi,
		tailnet?.availability,
		unlinkApi,
		updateTailnet,
	]);

	if (loading) {
		return (
			<section className="flex flex-1 items-center justify-center p-6">
				<Spinner />
			</section>
		);
	}

	const networkEnabled = network?.mode === "network-accessible";
	const canManageNetwork = rendererPlatformCapabilities().networkLifecycle;

	return (
		<section className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3 text-xs">
			{unavailableMethods.length > 0 && (
				<div
					role="status"
					className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-3 py-2"
				>
					<span>{uiMessage("settings:remote_check_failed")}</span>
					<Button
						className="h-7"
						variant="ghost"
						onClick={() => void refresh()}
					>
						{uiMessage("settings:remote_check_again")}
					</Button>
				</div>
			)}
			<AccessMethodsCard
				unavailableMethods={unavailableMethods}
				status={status}
				tailnet={tailnet}
				network={network}
				networkEnabled={networkEnabled}
				canManageNetwork={canManageNetwork}
				busy={busy}
				tailnetBusy={tailnetBusy}
				onOpenAccessDialog={setAccessDialog}
				onRequestNetworkMode={setPendingNetworkMode}
			/>
			<ConnectLinkCard
				status={unavailableMethods.includes("account") ? null : status}
				tailnet={unavailableMethods.includes("tailscale") ? null : tailnet}
				networkEnabled={networkEnabled && !unavailableMethods.includes("local")}
				tokens={tokens}
				onTokens={setTokens}
			/>
			<CloudDeviceAccessCard />
			<UsingComputersCard />
			<ConnectedDevicesCard
				tokens={tokens}
				onTokens={setTokens}
				refresh={refresh}
			/>

			<AccessConfirmDialogs
				accessDialog={accessDialog}
				onAccessDialogOpenChange={(open) => {
					if (!open && !busy && !tailnetBusy) setAccessDialog(null);
				}}
				onConfirmAccess={() => void confirmAccessChange()}
				pendingNetworkMode={pendingNetworkMode}
				onNetworkDialogOpenChange={(open) => {
					if (!open && !busy) setPendingNetworkMode(null);
				}}
				onConfirmNetwork={() => void updateNetwork()}
				busy={busy}
				tailnetBusy={tailnetBusy}
				tailnet={tailnet}
			/>
		</section>
	);
}
