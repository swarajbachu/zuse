import type {
	AuthTokenSummary,
	NetworkAccessState,
	PairingStartResult,
	RelayLinkStatus,
	TailnetShareState,
} from "@zuse/contracts";
import { Effect } from "effect";
import {
	Copy,
	ExternalLink,
	Monitor,
	QrCode,
	RefreshCw,
	Smartphone,
	Wifi,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import { formatError } from "../../lib/format-error.ts";
import {
	accessDeviceKind,
	deviceAccessCopy,
	groupPairedDeviceTokens,
} from "../../lib/paired-phones.ts";
import {
	copyText,
	openExternal,
	rendererPlatformCapabilities,
} from "../../lib/platform-capabilities.ts";
import { getRpcClient, LOCAL_ENVIRONMENT_KEY } from "../../lib/rpc-client.ts";
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
import { Card } from "../ui/card.tsx";
import { Frame, FrameFooter, FrameHeader, FrameTitle } from "../ui/frame.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { Switch } from "../ui/switch.tsx";
import { toastManager } from "../ui/toast.tsx";

const DEFAULT_RELAY_URL =
	(import.meta.env.VITE_ZUSE_RELAY_URL as string | undefined) ??
	"https://relay.stuff.md";

const messageForError = (cause: unknown): string => {
	const formatted = formatError(cause);
	if (formatted.includes("not_signed_in")) {
		return "Sign in before setting up remote access.";
	}
	if (formatted.includes("cloudflared_not_found")) {
		return "The secure tunnel needs cloudflared installed on this computer.";
	}
	if (formatted.includes("no_pairing_endpoint")) {
		return "Enable browser and device access before creating a connection link.";
	}
	if (formatted.includes("no_advertised_host")) {
		return "Connect both devices to the same network, then try again.";
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

const preferredBrowserPairingUrl = (
	pairing: PairingStartResult,
	status: RelayLinkStatus | null,
): string => {
	const priority = (reachability: string): number =>
		reachability === "tunnel" || reachability === "public"
			? 0
			: reachability === "lan"
				? 1
				: 2;
	const endpoint = status?.advertisedEndpoints
		?.filter(
			(candidate) =>
				candidate.status !== "unavailable" &&
				candidate.compatibility.hostedHttpsApp !== "mixed-content-blocked",
		)
		.sort(
			(left, right) =>
				priority(left.reachability) - priority(right.reachability),
		)[0];
	if (endpoint === undefined) return pairing.browserUrl;
	try {
		const url = new URL(endpoint.httpBaseUrl);
		url.hash = `pair=${encodeURIComponent(pairing.code)}`;
		return url.toString();
	} catch {
		return pairing.browserUrl;
	}
};

function AccessRow({
	icon,
	title,
	description,
	control,
}: {
	readonly icon: ReactNode;
	readonly title: string;
	readonly description: ReactNode;
	readonly control: ReactNode;
}) {
	return (
		<div className="flex min-h-14 items-center gap-2.5 px-3 py-2">
			<div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
				{icon}
			</div>
			<div className="min-w-0 flex-1">
				<p className="text-xs font-medium">{title}</p>
				<p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
					{description}
				</p>
			</div>
			<div className="flex min-h-11 shrink-0 items-center gap-1.5">
				{control}
			</div>
		</div>
	);
}

export function DevicesPane() {
	const [status, setStatus] = useState<RelayLinkStatus | null>(null);
	const [network, setNetwork] = useState<NetworkAccessState | null>(null);
	const [tailnet, setTailnet] = useState<TailnetShareState | null>(null);
	const [tokens, setTokens] = useState<ReadonlyArray<AuthTokenSummary>>([]);
	const [pairing, setPairing] = useState<PairingStartResult | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [pairingBusy, setPairingBusy] = useState(false);
	const [tailnetBusy, setTailnetBusy] = useState(false);
	const [pairingTarget, setPairingTarget] = useState<"browser" | "mobile">(
		"browser",
	);
	const [legacyRevokeOpen, setLegacyRevokeOpen] = useState(false);
	const [legacyRevokeBusy, setLegacyRevokeBusy] = useState(false);
	const [pendingNetworkMode, setPendingNetworkMode] = useState<boolean | null>(
		null,
	);
	const actionInFlightRef = useRef(false);
	const pairingTokenIdsRef = useRef<ReadonlySet<string>>(new Set());

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

	useEffect(() => {
		if (pairing === null) return;
		const checkForPairedPhone = async () => {
			try {
				const client = await getRpcClient(LOCAL_ENVIRONMENT_KEY);
				const next = await Effect.runPromise(client["pairing.listTokens"]({}));
				setTokens(next);
				if (
					next.some(
						(token) =>
							token.revokedAt === undefined &&
							!pairingTokenIdsRef.current.has(token.id),
					)
				) {
					setPairing(null);
				}
			} catch {
				// The main refresh/error path remains authoritative; retry next poll.
			}
		};
		const timer = setInterval(() => void checkForPairedPhone(), 1_500);
		return () => clearInterval(timer);
	}, [pairing]);

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

	const startPairing = useCallback(
		async (
			target: "browser" | "mobile",
			privateAccess: TailnetShareState | null = tailnet,
		) => {
			if (pairingBusy) return;
			setPairingTarget(target);
			setPairingBusy(true);
			try {
				const client = await getRpcClient(LOCAL_ENVIRONMENT_KEY);
				pairingTokenIdsRef.current = new Set(
					tokens
						.filter((token) => token.revokedAt === undefined)
						.map((token) => token.id),
				);
				const next = await Effect.runPromise(client["pairing.start"]({}));
				if (privateAccess?.enabled === true && privateAccess.dnsName !== null) {
					const httpBaseUrl = `https://${privateAccess.dnsName}`;
					const wsBaseUrl = `wss://${privateAccess.dnsName}/rpc`;
					setPairing({
						...next,
						pairingUrl: wsBaseUrl,
						browserUrl: `${httpBaseUrl}/#pair=${encodeURIComponent(next.code)}`,
						qrText: `zuse:///connect/pair?pairingUrl=${encodeURIComponent(wsBaseUrl)}#token=${next.code}`,
					});
				} else {
					setPairing(next);
				}
			} catch (cause) {
				showError("Could not start pairing", cause);
			} finally {
				setPairingBusy(false);
			}
		},
		[pairingBusy, tailnet, tokens],
	);

	const connectDevice = useCallback(async () => {
		if (pairingBusy || tailnetBusy) return;
		if (tailnet?.enabled === true) {
			await startPairing("mobile");
			return;
		}
		if (tailnet?.availability === "available") {
			const next = await updateTailnet(true);
			if (next?.enabled === true) await startPairing("mobile", next);
			return;
		}
		if (network?.mode === "network-accessible" || status?.linked === true) {
			await startPairing("mobile");
			return;
		}
		if (tailnet?.availability === "approval-required") {
			const next = await updateTailnet(true);
			if (next?.enabled === true) await startPairing("mobile", next);
			return;
		}
		if (tailnet?.availability === "not-installed") {
			await openExternal("https://tailscale.com/download");
			return;
		}
		if (tailnet?.availability === "signed-out") {
			showError(
				"Tailscale sign-in required",
				new Error("Open Tailscale, sign in, then try connecting again."),
			);
			return;
		}
		await updateTailnet(true);
	}, [
		network?.mode,
		pairingBusy,
		startPairing,
		status?.linked,
		tailnet,
		tailnetBusy,
		updateTailnet,
	]);

	const revokeToken = useCallback(async (token: AuthTokenSummary) => {
		try {
			const client = await getRpcClient(LOCAL_ENVIRONMENT_KEY);
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

	const revokeTokens = useCallback(
		async (items: ReadonlyArray<AuthTokenSummary>) => {
			if (legacyRevokeBusy) return;
			setLegacyRevokeBusy(true);
			try {
				const client = await getRpcClient(LOCAL_ENVIRONMENT_KEY);
				const results = await Promise.allSettled(
					items.map((token) =>
						Effect.runPromise(
							client["pairing.revokeToken"]({ tokenId: token.id }),
						),
					),
				);
				await refresh();
				if (results.some((result) => result.status === "rejected")) {
					throw new Error("Some credentials could not be revoked. Try again.");
				}
				setLegacyRevokeOpen(false);
			} catch (cause) {
				showError("Could not revoke older device access", cause);
			} finally {
				setLegacyRevokeBusy(false);
			}
		},
		[legacyRevokeBusy, refresh],
	);

	const connectRelay = useCallback(async () => {
		if (actionInFlightRef.current) return;
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
		} catch (cause) {
			showError("Could not set up remote access", cause);
		} finally {
			actionInFlightRef.current = false;
			setBusy(false);
		}
	}, []);

	const unlinkRelay = useCallback(async () => {
		if (actionInFlightRef.current) return;
		actionInFlightRef.current = true;
		setBusy(true);
		try {
			const client = await getRpcClient(LOCAL_ENVIRONMENT_KEY);
			await Effect.runPromise(client["relay.unlink"]());
			setStatus(null);
		} catch (cause) {
			showError("Could not turn off remote access", cause);
		} finally {
			actionInFlightRef.current = false;
			setBusy(false);
		}
	}, []);

	if (loading) {
		return (
			<section className="flex flex-1 items-center justify-center p-6">
				<Spinner />
			</section>
		);
	}

	const networkEnabled = network?.mode === "network-accessible";
	const canManageNetwork = rendererPlatformCapabilities().networkLifecycle;
	const linked = status?.linked === true;
	const remoteReady = linked && status?.heartbeatActive === true;
	const { identifiedDevices, legacyCredentials } =
		groupPairedDeviceTokens(tokens);
	const hasActiveTokens =
		identifiedDevices.length > 0 || legacyCredentials.length > 0;
	const canConnectDevice =
		tailnet?.enabled === true || networkEnabled || remoteReady;
	const browserUrl =
		pairing === null
			? null
			: tailnet?.enabled === true
				? pairing.browserUrl
				: preferredBrowserPairingUrl(pairing, status);
	const preparingConnection = pairingBusy || tailnetBusy;
	const connectActionLabel = preparingConnection
		? "Preparing…"
		: tailnet?.availability === "not-installed" && !canConnectDevice
			? "Install Tailscale"
			: tailnet?.availability === "approval-required"
				? "Finish setup"
				: "Connect device";
	return (
		<section className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3 text-xs">
			<Frame>
				<Card className="overflow-hidden">
					<div className="flex items-center gap-3 p-4">
						<div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
							<Smartphone className="size-5" aria-hidden />
						</div>
						<div className="min-w-0 flex-1">
							<p className="text-[13px] font-medium">
								Use Zuse on another device
							</p>
							<p className="mt-1 text-[11px] leading-4 text-muted-foreground">
								{tailnet?.enabled === true
									? "Create a private link for a phone, browser, or another computer."
									: "Zuse will prepare private access and create a one-time connection link."}
							</p>
						</div>
						<Button
							onClick={() => void connectDevice()}
							disabled={preparingConnection}
						>
							{connectActionLabel}
						</Button>
					</div>
					<div className="flex min-h-10 items-center gap-2 border-t border-border/40 px-4 text-[11px] text-muted-foreground">
						<span
							aria-hidden
							className={`size-1.5 rounded-full ${tailnet?.enabled === true ? "bg-emerald-500" : "bg-muted-foreground/35"}`}
						/>
						<span className="min-w-0 flex-1 truncate">
							{tailnet?.enabled === true
								? `Private access ready${tailnet.dnsName ? ` · ${tailnet.dnsName}` : ""}`
								: "Private access is prepared when you connect a device"}
						</span>
						{tailnet?.enabled === true ? (
							<Button
								size="xs"
								variant="ghost"
								onClick={() => void updateTailnet(false)}
								disabled={tailnetBusy}
							>
								Turn off
							</Button>
						) : null}
					</div>
				</Card>
				<FrameFooter className="px-2 py-1.5 text-[11px] text-muted-foreground">
					On a headless computer, run <code>zuse serve</code> once.
				</FrameFooter>
			</Frame>

			{pairing !== null && (
				<Frame>
					<FrameHeader className="px-2 py-1.5">
						<FrameTitle className="text-[13px] font-medium">
							{pairingTarget === "browser"
								? "Connect a web browser"
								: "Connect another device"}
						</FrameTitle>
						<p className="mt-0.5 text-[11px] text-muted-foreground">
							This one-time link expires in five minutes. Access remains until
							you revoke the connected device below.
						</p>
					</FrameHeader>
					<Card>
						<div className="grid gap-3 p-3 sm:grid-cols-[132px_1fr]">
							<div
								className="flex size-[132px] items-center justify-center rounded-lg bg-white p-2.5"
								role="img"
								aria-label="Pairing QR code"
							>
								<QRCodeSVG
									value={
										pairingTarget === "browser"
											? (browserUrl ?? pairing.browserUrl)
											: pairing.qrText
									}
									size={112}
									level="M"
								/>
							</div>
							<div className="flex min-w-0 flex-col justify-center gap-2.5">
								<div className="flex flex-wrap gap-2">
									<Button
										size="xs"
										variant="outline"
										onClick={() =>
											setPairingTarget((current) =>
												current === "browser" ? "mobile" : "browser",
											)
										}
									>
										<QrCode aria-hidden />
										{pairingTarget === "browser"
											? "Show phone QR"
											: "Show browser QR"}
									</Button>
									{pairingTarget === "browser" && (
										<>
											<Button
												size="xs"
												variant="outline"
												onClick={() =>
													void copyText(browserUrl ?? pairing.browserUrl)
												}
											>
												<Copy aria-hidden />
												Copy web link
											</Button>
											<Button
												size="xs"
												onClick={() =>
													void openExternal(browserUrl ?? pairing.browserUrl)
												}
											>
												<ExternalLink aria-hidden />
												Open web app
											</Button>
										</>
									)}
									{pairingTarget === "mobile" && (
										<Button
											size="xs"
											variant="outline"
											onClick={() => void copyText(pairing.qrText)}
										>
											<Copy aria-hidden />
											Copy pairing link
										</Button>
									)}
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
								<Button
									size="xs"
									variant="outline"
									onClick={() => void startPairing(pairingTarget)}
								>
									<RefreshCw aria-hidden />
									New code
								</Button>
							</div>
						</div>
					</Card>
				</Frame>
			)}

			<Frame>
				<FrameHeader className="px-2 py-1.5">
					<FrameTitle className="text-[13px] font-medium">
						{deviceAccessCopy.pairedTitle}
					</FrameTitle>
					<p className="mt-0.5 text-[11px] text-muted-foreground">
						Devices that can open this computer’s projects and chats.
					</p>
				</FrameHeader>
				<Card className="overflow-hidden">
					{hasActiveTokens ? (
						<div className="flex flex-col divide-y divide-border/40">
							{identifiedDevices.map((token) => (
								<div
									key={token.id}
									className="flex min-h-11 items-center gap-2.5 px-3 py-2"
								>
									{accessDeviceKind(token) === "browser" ? (
										<Monitor
											className="size-4 shrink-0 text-muted-foreground"
											aria-hidden
										/>
									) : (
										<Smartphone
											className="size-4 shrink-0 text-muted-foreground"
											aria-hidden
										/>
									)}
									<div className="min-w-0 flex-1">
										<p className="truncate text-xs font-medium">
											{token.label ??
												(accessDeviceKind(token) === "browser"
													? "Web browser"
													: "Mobile device")}
										</p>
										<p className="text-[11px] text-muted-foreground">
											{token.lastUsedAt
												? `Last connected ${token.lastUsedAt.toLocaleString()}`
												: "Not connected yet"}
										</p>
									</div>
									<Button
										size="xs"
										variant="destructive-outline"
										onClick={() => void revokeToken(token)}
									>
										Revoke
									</Button>
								</div>
							))}
							{legacyCredentials.length > 0 && (
								<div className="flex min-h-11 items-center gap-2.5 px-3 py-2">
									<Smartphone
										className="size-4 shrink-0 text-muted-foreground"
										aria-hidden
									/>
									<div className="min-w-0 flex-1">
										<p className="truncate text-xs font-medium">
											Older device access
										</p>
										<p className="text-[11px] text-muted-foreground">
											{legacyCredentials.length} access credential
											{legacyCredentials.length === 1 ? "" : "s"} from an
											earlier version
										</p>
									</div>
									<Button
										size="xs"
										variant="destructive-outline"
										onClick={() => setLegacyRevokeOpen(true)}
									>
										Revoke all
									</Button>
								</div>
							)}
						</div>
					) : (
						<p className="px-3 py-4 text-[11px] text-muted-foreground">
							No other devices are connected yet.
						</p>
					)}
				</Card>
			</Frame>

			<Frame>
				<FrameHeader className="px-2 py-1.5">
					<FrameTitle className="text-[13px] font-medium">
						Other access methods
					</FrameTitle>
					<p className="mt-0.5 text-[11px] text-muted-foreground">
						Useful when private access is unavailable.
					</p>
				</FrameHeader>
				<Card className="overflow-hidden">
					<div className="flex flex-col divide-y divide-border/40">
						<AccessRow
							icon={<Wifi className="size-4" aria-hidden />}
							title="Local network"
							description={
								networkEnabled
									? "Available to devices on this network."
									: "Connect from a browser on the same network."
							}
							control={
								canManageNetwork ? (
									<Switch
										aria-label="Local network access"
										checked={networkEnabled}
										onCheckedChange={setPendingNetworkMode}
										disabled={busy}
									/>
								) : (
									<span className="text-[11px] text-muted-foreground">
										Desktop only
									</span>
								)
							}
						/>
						<AccessRow
							icon={<ExternalLink className="size-4" aria-hidden />}
							title="Account access"
							description={
								remoteReady
									? "Available anywhere through your account."
									: linked
										? "Linked and waiting to reconnect."
										: "Use your account when private access is unavailable."
							}
							control={
								<Switch
									aria-label="Account access"
									checked={linked}
									onCheckedChange={(checked) =>
										void (checked ? connectRelay() : unlinkRelay())
									}
									disabled={busy}
								/>
							}
						/>
					</div>
				</Card>
			</Frame>

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
								? "Turn on local access?"
								: "Turn off local access?"}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingNetworkMode
								? "The app will restart so browsers and mobile devices can connect over this network. Running agents will stop during the restart."
								: "The app will restart and connected browsers and mobile devices on this network will disconnect."}
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
									? "Restart and turn on"
									: "Restart and turn off"}
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>

			<AlertDialog
				open={legacyRevokeOpen}
				onOpenChange={(open) => {
					if (!legacyRevokeBusy) setLegacyRevokeOpen(open);
				}}
			>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle>Revoke older device access?</AlertDialogTitle>
						<AlertDialogDescription>
							This removes {legacyCredentials.length} older access credential
							{legacyCredentials.length === 1 ? "" : "s"}. Any browser or device
							still using them will need to connect again.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose
							render={<Button variant="outline" disabled={legacyRevokeBusy} />}
						>
							Cancel
						</AlertDialogClose>
						<Button
							variant="destructive"
							disabled={legacyRevokeBusy}
							onClick={() => void revokeTokens(legacyCredentials)}
						>
							{legacyRevokeBusy ? "Revoking…" : "Revoke access"}
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</section>
	);
}
