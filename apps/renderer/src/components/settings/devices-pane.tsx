import type {
	AuthTokenSummary,
	NetworkAccessState,
	RelayLinkStatus,
	TailnetShareState,
} from "@zuse/contracts";
import { Effect } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";

import {
	openExternal,
	rendererPlatformCapabilities,
} from "../../lib/platform-capabilities.ts";
import { getRpcClient, LOCAL_ENVIRONMENT_KEY } from "../../lib/rpc-client.ts";
import { Spinner } from "../ui/spinner.tsx";
import {
	AccessConfirmDialogs,
	type AccessDialog,
} from "./remote-access/access-confirm-dialogs.tsx";
import { showError } from "./remote-access/access-errors.ts";
import { AccessMethodsCard } from "./remote-access/access-methods-card.tsx";
import { ConnectLinkCard } from "./remote-access/connect-link-card.tsx";
import { ConnectedDevicesCard } from "./remote-access/connected-devices-card.tsx";
import { UsingComputersCard } from "./remote-access/using-computers-card.tsx";

const DEFAULT_RELAY_URL =
	(import.meta.env.VITE_ZUSE_RELAY_URL as string | undefined) ??
	"https://relay.stuff.md";

/**
 * Remote-access settings data and mutations. Presentation is composed from
 * the same compact Frame/Card patterns as the rest of settings.
 */
export function DevicesPane() {
	const [status, setStatus] = useState<RelayLinkStatus | null>(null);
	const [network, setNetwork] = useState<NetworkAccessState | null>(null);
	const [tailnet, setTailnet] = useState<TailnetShareState | null>(null);
	const [tokens, setTokens] = useState<ReadonlyArray<AuthTokenSummary>>([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [tailnetBusy, setTailnetBusy] = useState(false);
	const [pendingNetworkMode, setPendingNetworkMode] = useState<boolean | null>(
		null,
	);
	const [accessDialog, setAccessDialog] = useState<AccessDialog>(null);
	const actionInFlightRef = useRef(false);

	const refresh = useCallback(async () => {
		const bridge = window.zuse ?? window.memoize;
		const client = await getRpcClient(LOCAL_ENVIRONMENT_KEY);
		const [networkResult, tailnetResult, relayResult, tokenResult] =
			await Promise.allSettled([
				bridge?.network?.getAccessState() ?? Promise.resolve(null),
				bridge?.network?.getTailnetShareState() ?? Promise.resolve(null),
				Effect.runPromise(client["relay.status"]()),
				Effect.runPromise(client["pairing.listTokens"]({})),
			]);
		if (networkResult.status === "fulfilled") setNetwork(networkResult.value);
		if (tailnetResult.status === "fulfilled") setTailnet(tailnetResult.value);
		if (relayResult.status === "fulfilled") setStatus(relayResult.value);
		if (tokenResult.status === "fulfilled") setTokens(tokenResult.value);
		setLoading(false);
	}, []);

	useEffect(() => {
		void refresh().catch((cause) => {
			setLoading(false);
			showError("Could not load device access", cause);
		});
	}, [refresh]);

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
					// A conflict is rendered on the Tailscale row (Replace/Details),
					// never surfaced as an error toast.
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

	const connectRelay = useCallback(async (): Promise<boolean> => {
		if (actionInFlightRef.current) return false;
		actionInFlightRef.current = true;
		setBusy(true);
		try {
			const client = await getRpcClient(LOCAL_ENVIRONMENT_KEY);
			setStatus(
				await Effect.runPromise(
					client["relay.link"]({
						relayUrl: DEFAULT_RELAY_URL.trim().replace(/\/$/, ""),
					}),
				),
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

	const unlinkRelay = useCallback(async (): Promise<boolean> => {
		if (actionInFlightRef.current) return false;
		actionInFlightRef.current = true;
		setBusy(true);
		try {
			const client = await getRpcClient(LOCAL_ENVIRONMENT_KEY);
			await Effect.runPromise(client["relay.unlink"]());
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
				? await connectRelay()
				: accessDialog === "serve-disable"
					? await unlinkRelay()
					: (await updateTailnet(accessDialog === "tailscale-enable")) !== null;
		if (changed) setAccessDialog(null);
	}, [
		accessDialog,
		connectRelay,
		tailnet?.availability,
		unlinkRelay,
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
			<AccessMethodsCard
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
				status={status}
				tailnet={tailnet}
				networkEnabled={networkEnabled}
				tokens={tokens}
				onTokens={setTokens}
			/>
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
