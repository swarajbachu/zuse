import type {
	AdvertisedEndpoint,
	AuthTokenSummary,
	NetworkAccessState,
	PairingStartResult,
	RelayLinkStatus,
} from "@zuse/contracts";
import { Effect } from "effect";
import {
	Check,
	ChevronDown,
	Copy,
	QrCode,
	RefreshCw,
	Smartphone,
	Wifi,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
	readEndpointOverride,
	selectAdvertisedEndpoint,
	writeEndpointOverride,
} from "../../lib/advertised-endpoints.ts";
import { getBridge } from "../../lib/bridge.ts";
import { formatError } from "../../lib/format-error.ts";
import { getRpcClient } from "../../lib/rpc-client.ts";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "../ui/alert-dialog.tsx";
import { Button } from "../ui/button.tsx";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "../ui/collapsible.tsx";
import { Frame, FrameFooter, FramePanel, FrameTitle } from "../ui/frame.tsx";
import { Input } from "../ui/input.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { toastManager } from "../ui/toast.tsx";

const DEFAULT_RELAY_URL =
	(import.meta.env.VITE_ZUSE_RELAY_URL as string | undefined) ??
	"https://relay.stuff.md";

const messageForError = (cause: unknown): string => {
	const formatted = formatError(cause);
	if (formatted.includes("not_signed_in")) {
		return "Sign in before linking this computer to your account.";
	}
	if (formatted.includes("cloudflared_not_found")) {
		return "The secure tunnel needs cloudflared installed on this computer.";
	}
	if (formatted.includes("no_pairing_endpoint")) {
		return "Start network access before pairing a phone.";
	}
	if (formatted.includes("no_advertised_host")) {
		return "Connect this computer and phone to the same network, then try again.";
	}
	if (
		formatted.includes("Failed to fetch") ||
		formatted.includes("NetworkError") ||
		formatted.includes("relay_50")
	) {
		return "The network service could not be reached. Check your connection and try again.";
	}
	return formatted || "Something went wrong. Try again.";
};

const showError = (title: string, cause: unknown): void => {
	toastManager.add({
		type: "error",
		title,
		description: messageForError(cause),
	});
};

export function DevicesPane() {
	const [status, setStatus] = useState<RelayLinkStatus | null>(null);
	const [network, setNetwork] = useState<NetworkAccessState | null>(null);
	const [tokens, setTokens] = useState<ReadonlyArray<AuthTokenSummary>>([]);
	const [pairing, setPairing] = useState<PairingStartResult | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [pairingBusy, setPairingBusy] = useState(false);
	const [pendingNetworkMode, setPendingNetworkMode] = useState<boolean | null>(
		null,
	);
	const [label, setLabel] = useState("");
	const [endpointOverrideId, setEndpointOverrideId] = useState<string | null>(
		() => readEndpointOverride(),
	);
	const [endpointsOpen, setEndpointsOpen] = useState(false);
	const actionInFlightRef = useRef(false);

	const refresh = useCallback(async () => {
		const bridge = getBridge();
		const client = await getRpcClient();
		const [networkResult, relayResult, tokenResult] = await Promise.allSettled([
			bridge.network?.getAccessState() ?? Promise.resolve(null),
			Effect.runPromise(client["relay.status"]()),
			Effect.runPromise(client["pairing.listTokens"]({})),
		]);
		if (networkResult.status === "fulfilled") setNetwork(networkResult.value);
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

	useEffect(() => {
		if (pairing === null) return;
		const remaining = pairing.expiresAt.getTime() - Date.now();
		if (remaining <= 0) {
			setPairing(null);
			return;
		}
		const timer = setTimeout(() => setPairing(null), remaining);
		return () => clearTimeout(timer);
	}, [pairing]);

	const updateNetwork = useCallback(async () => {
		if (pendingNetworkMode === null) return;
		const bridge = getBridge();
		if (bridge.network === undefined) {
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

	const startPairing = useCallback(async () => {
		if (pairingBusy) return;
		setPairingBusy(true);
		try {
			const client = await getRpcClient();
			setPairing(await Effect.runPromise(client["pairing.start"]({})));
		} catch (cause) {
			showError("Could not start pairing", cause);
		} finally {
			setPairingBusy(false);
		}
	}, [pairingBusy]);

	const revokeToken = useCallback(async (token: AuthTokenSummary) => {
		try {
			const client = await getRpcClient();
			await Effect.runPromise(
				client["pairing.revokeToken"]({ tokenId: token.id }),
			);
			setTokens((current) =>
				current.map((item) =>
					item.id === token.id ? { ...item, revokedAt: new Date() } : item,
				),
			);
		} catch (cause) {
			showError("Could not revoke device access", cause);
		}
	}, []);

	const connectRelay = useCallback(async () => {
		if (actionInFlightRef.current) return;
		actionInFlightRef.current = true;
		setBusy(true);
		try {
			const client = await getRpcClient();
			setStatus(
				await Effect.runPromise(
					client["relay.link"]({
						relayUrl: DEFAULT_RELAY_URL.trim().replace(/\/$/, ""),
						label: label.trim() || undefined,
					}),
				),
			);
		} catch (cause) {
			showError("Could not enable anywhere access", cause);
		} finally {
			actionInFlightRef.current = false;
			setBusy(false);
		}
	}, [label]);

	const unlinkRelay = useCallback(async () => {
		if (actionInFlightRef.current) return;
		actionInFlightRef.current = true;
		setBusy(true);
		try {
			const client = await getRpcClient();
			await Effect.runPromise(client["relay.unlink"]());
			setStatus(null);
		} catch (cause) {
			showError("Could not disable anywhere access", cause);
		} finally {
			actionInFlightRef.current = false;
			setBusy(false);
		}
	}, []);

	const selectEndpoint = useCallback((endpointId: string) => {
		setEndpointOverrideId(endpointId);
		writeEndpointOverride(endpointId);
	}, []);

	if (loading) {
		return (
			<section className="flex flex-1 items-center justify-center p-6">
				<Spinner />
			</section>
		);
	}

	const networkEnabled = network?.mode === "network-accessible";
	const linked = status?.linked === true;
	const advertisedEndpoints = status?.advertisedEndpoints ?? [];
	const selectedEndpoint = selectAdvertisedEndpoint(
		advertisedEndpoints,
		endpointOverrideId,
	);
	const activeTokens = tokens.filter((token) => token.revokedAt === undefined);

	return (
		<section className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
			<Frame>
				<FramePanel className="space-y-3 p-3">
					<div className="flex items-start gap-3">
						<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
							<Wifi className="size-4" aria-hidden />
						</div>
						<div className="min-w-0 flex-1">
							<FrameTitle>Local network access</FrameTitle>
							<p className="mt-1 text-xs text-muted-foreground">
								{networkEnabled
									? `Reachable at ${network?.endpointUrl ?? "your local network"}`
									: "Off. Only this app can reach the desktop server."}
							</p>
						</div>
						<span
							className={
								networkEnabled
									? "rounded-md bg-emerald-500/12 px-2 py-1 text-xs text-emerald-600 dark:text-emerald-400"
									: "rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
							}
						>
							{networkEnabled ? "On" : "Off"}
						</span>
					</div>
					<p className="text-xs text-muted-foreground">
						Pairing uses a one-time code. Each phone receives its own revocable
						credential; no account or cloud relay is required on the same Wi-Fi.
					</p>
				</FramePanel>
				<FrameFooter className="flex justify-end gap-2 px-3 py-2.5">
					{networkEnabled ? (
						<>
							<Button
								variant="outline"
								onClick={() => setPendingNetworkMode(false)}
								disabled={busy}
							>
								Stop network
							</Button>
							<Button
								onClick={() => void startPairing()}
								disabled={pairingBusy}
							>
								<QrCode aria-hidden />
								{pairingBusy ? "Starting…" : "Pair a phone"}
							</Button>
						</>
					) : (
						<Button onClick={() => setPendingNetworkMode(true)} disabled={busy}>
							Start network
						</Button>
					)}
				</FrameFooter>
			</Frame>

			{pairing !== null && (
				<Frame>
					<FramePanel className="grid gap-4 p-4 sm:grid-cols-[180px_1fr]">
						<div
							className="flex size-[180px] items-center justify-center rounded-xl bg-white p-3"
							role="img"
							aria-label="Pairing QR code"
						>
							<QRCodeSVG value={pairing.qrText} size={156} level="M" />
						</div>
						<div className="flex min-w-0 flex-col justify-center gap-3">
							<div>
								<FrameTitle>Scan with the mobile app</FrameTitle>
								<p className="mt-1 text-xs text-muted-foreground">
									Keep both devices on the same network. This code expires in
									five minutes and works once.
								</p>
							</div>
							<div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-muted/30 p-2">
								<code className="min-w-0 flex-1 truncate text-xs">
									{pairing.code}
								</code>
								<Button
									size="icon-sm"
									variant="ghost"
									aria-label="Copy pairing code"
									onClick={() =>
										void navigator.clipboard.writeText(pairing.code)
									}
								>
									<Copy aria-hidden />
								</Button>
							</div>
							<Button variant="outline" onClick={() => void startPairing()}>
								<RefreshCw aria-hidden />
								New code
							</Button>
						</div>
					</FramePanel>
				</Frame>
			)}

			{activeTokens.length > 0 && (
				<Frame>
					<FramePanel className="space-y-3 p-3">
						<FrameTitle>Paired devices</FrameTitle>
						<div className="flex flex-col gap-2">
							{activeTokens.map((token) => (
								<div
									key={token.id}
									className="flex min-h-11 items-center gap-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-2"
								>
									<Smartphone
										className="size-4 shrink-0 text-muted-foreground"
										aria-hidden
									/>
									<div className="min-w-0 flex-1">
										<p className="truncate text-sm font-medium">
											{token.label ?? "Paired phone"}
										</p>
										<p className="text-xs text-muted-foreground">
											{token.lastUsedAt
												? `Last connected ${token.lastUsedAt.toLocaleString()}`
												: "Not connected yet"}
										</p>
									</div>
									<Button
										size="sm"
										variant="destructive-outline"
										onClick={() => void revokeToken(token)}
									>
										Revoke
									</Button>
								</div>
							))}
						</div>
					</FramePanel>
				</Frame>
			)}

			<Frame>
				<FramePanel className="space-y-3 p-3">
					<div className="flex items-center gap-2">
						<span
							className={
								status?.heartbeatActive === true
									? "size-2 rounded-full bg-emerald-500"
									: "size-2 rounded-full bg-muted-foreground/40"
							}
							aria-hidden
						/>
						<FrameTitle>Anywhere access</FrameTitle>
					</div>
					{linked ? (
						<>
							<p className="text-xs text-muted-foreground">
								{status?.label ?? "This computer"} is linked to your account and
								reachable from your phone away from home.
							</p>
							{selectedEndpoint !== null && (
								<EndpointSummary endpoint={selectedEndpoint} />
							)}
						</>
					) : (
						<>
							<p className="text-xs text-muted-foreground">
								Optional. Link this computer to your signed-in account for
								secure access outside the local network.
							</p>
							<label
								htmlFor="device-computer-label"
								className="flex flex-col gap-2 text-sm font-medium"
							>
								Computer name (optional)
								<Input
									id="device-computer-label"
									value={label}
									onChange={(event) => setLabel(event.target.value)}
									placeholder="This computer"
								/>
							</label>
						</>
					)}
				</FramePanel>
				<FrameFooter className="flex justify-end px-3 py-2.5">
					<Button
						variant={linked ? "destructive" : "default"}
						onClick={() => void (linked ? unlinkRelay() : connectRelay())}
						disabled={busy}
					>
						{linked
							? "Unlink"
							: busy
								? "Connecting…"
								: "Enable anywhere access"}
					</Button>
				</FrameFooter>
			</Frame>

			{advertisedEndpoints.length > 0 && (
				<Collapsible open={endpointsOpen} onOpenChange={setEndpointsOpen}>
					<Frame>
						<FramePanel className="p-3">
							<CollapsibleTrigger className="flex min-h-11 w-full items-center justify-between gap-3 text-left">
								<FrameTitle>Connection routes</FrameTitle>
								<ChevronDown
									className={
										endpointsOpen
											? "size-4 rotate-180 text-muted-foreground transition-transform"
											: "size-4 text-muted-foreground transition-transform"
									}
									aria-hidden
								/>
							</CollapsibleTrigger>
							<CollapsibleContent>
								<div className="flex flex-col gap-2 pt-2">
									{advertisedEndpoints.map((endpoint) => {
										const selected = selectedEndpoint?.id === endpoint.id;
										return (
											<button
												key={endpoint.id}
												type="button"
												className="flex min-h-11 min-w-0 items-start gap-3 rounded-lg border border-border/50 bg-muted/20 p-3 text-left hover:bg-muted/40"
												onClick={() => selectEndpoint(endpoint.id)}
											>
												<span
													className={
														selected
															? "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
															: "mt-0.5 size-5 shrink-0 rounded-full border border-border"
													}
													aria-hidden
												>
													{selected ? <Check className="size-3" /> : null}
												</span>
												<EndpointDetails endpoint={endpoint} />
											</button>
										);
									})}
								</div>
							</CollapsibleContent>
						</FramePanel>
					</Frame>
				</Collapsible>
			)}

			<AlertDialog
				open={pendingNetworkMode !== null}
				onOpenChange={(open) => {
					if (!open && !busy) setPendingNetworkMode(null);
				}}
			>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{pendingNetworkMode
								? "Start network access?"
								: "Stop network access?"}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingNetworkMode
								? "The app will restart and accept authenticated connections from your local network. Running agents will stop during the restart."
								: "The app will restart and return the server to this computer only. Paired phones will disconnect."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose
							render={<Button variant="outline" disabled={busy} />}
						>
							Cancel
						</AlertDialogClose>
						<Button
							variant={pendingNetworkMode ? "default" : "destructive"}
							onClick={() => void updateNetwork()}
							disabled={busy}
						>
							{busy
								? "Restarting…"
								: pendingNetworkMode
									? "Restart and start"
									: "Restart and stop"}
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</section>
	);
}

function EndpointSummary({ endpoint }: { endpoint: AdvertisedEndpoint }) {
	return (
		<div>
			<div className="flex items-center justify-between gap-3">
				<span className="truncate text-xs font-medium">Default route</span>
				<EndpointBadge endpoint={endpoint} />
			</div>
			<p className="mt-1 truncate text-xs text-muted-foreground">
				{endpoint.label} · {endpoint.status}
			</p>
		</div>
	);
}

function EndpointDetails({ endpoint }: { endpoint: AdvertisedEndpoint }) {
	return (
		<div className="min-w-0 flex-1">
			<div className="flex min-w-0 items-center justify-between gap-2">
				<div className="truncate text-sm font-medium">{endpoint.label}</div>
				<EndpointBadge endpoint={endpoint} />
			</div>
			<div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
				<span>{endpoint.providerKind}</span>
				<span>·</span>
				<span>{endpoint.reachability}</span>
				<span>·</span>
				<span>{endpoint.status}</span>
			</div>
		</div>
	);
}

function EndpointBadge({ endpoint }: { endpoint: AdvertisedEndpoint }) {
	return (
		<span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
			{endpoint.reachability}
		</span>
	);
}
