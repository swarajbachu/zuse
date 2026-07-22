import type {
	AuthTokenSummary,
	NetworkAccessState,
	PairingStartResult,
	RelayLinkStatus,
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
import { useCallback, useEffect, useRef, useState } from "react";

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

export function DevicesPane() {
	const [status, setStatus] = useState<RelayLinkStatus | null>(null);
	const [network, setNetwork] = useState<NetworkAccessState | null>(null);
	const [tokens, setTokens] = useState<ReadonlyArray<AuthTokenSummary>>([]);
	const [pairing, setPairing] = useState<PairingStartResult | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [pairingBusy, setPairingBusy] = useState(false);
	const [pairingTarget, setPairingTarget] = useState<"browser" | "mobile">(
		"browser",
	);
	const [legacyRevokeOpen, setLegacyRevokeOpen] = useState(false);
	const [legacyRevokeBusy, setLegacyRevokeBusy] = useState(false);
	const [pendingNetworkMode, setPendingNetworkMode] = useState<boolean | null>(
		null,
	);
	const [label, setLabel] = useState("");
	const actionInFlightRef = useRef(false);
	const pairingTokenIdsRef = useRef<ReadonlySet<string>>(new Set());

	const refresh = useCallback(async () => {
		const bridge = window.zuse ?? window.memoize;
		const client = await getRpcClient();
		const [networkResult, relayResult, tokenResult] = await Promise.allSettled([
			bridge?.network?.getAccessState() ?? Promise.resolve(null),
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

	useEffect(() => {
		if (pairing === null) return;
		const checkForPairedPhone = async () => {
			try {
				const client = await getRpcClient();
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

	const startPairing = useCallback(
		async (target: "browser" | "mobile") => {
			if (pairingBusy) return;
			setPairingTarget(target);
			setPairingBusy(true);
			try {
				const client = await getRpcClient();
				pairingTokenIdsRef.current = new Set(
					tokens
						.filter((token) => token.revokedAt === undefined)
						.map((token) => token.id),
				);
				setPairing(await Effect.runPromise(client["pairing.start"]({})));
			} catch (cause) {
				showError("Could not start pairing", cause);
			} finally {
				setPairingBusy(false);
			}
		},
		[pairingBusy, tokens],
	);

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

	const revokeTokens = useCallback(
		async (items: ReadonlyArray<AuthTokenSummary>) => {
			if (legacyRevokeBusy) return;
			setLegacyRevokeBusy(true);
			try {
				const client = await getRpcClient();
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
			showError("Could not set up remote access", cause);
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
	const browserUrl =
		pairing === null ? null : preferredBrowserPairingUrl(pairing, status);

	return (
		<section className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 text-[13px]">
			<Frame>
				<FramePanel className="space-y-2.5 p-2.5">
					<div className="flex items-start gap-3">
						<div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
							<Wifi className="size-4" aria-hidden />
						</div>
						<div className="min-w-0 flex-1">
							<FrameTitle>{deviceAccessCopy.localTitle}</FrameTitle>
							<p className="mt-1 text-xs text-muted-foreground">
								{networkEnabled
									? "Use this environment from a web browser or the mobile app on this network."
									: "Enable network access to connect a browser or another device."}
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
						This computer owns the projects, files, agents, and terminals. Each
						connected client gets revocable access from a one-time link.
					</p>
				</FramePanel>
				<FrameFooter className="flex flex-wrap justify-end gap-2 px-2.5 py-2">
					{!canManageNetwork ? (
						<p className="text-right text-xs text-muted-foreground">
							Network access is managed from the desktop app.
						</p>
					) : networkEnabled ? (
						<>
							<Button
								size="xs"
								variant="outline"
								onClick={() => setPendingNetworkMode(false)}
								disabled={busy}
							>
								Turn off local access
							</Button>
							<Button
								size="xs"
								variant="outline"
								onClick={() => void startPairing("mobile")}
								disabled={pairingBusy}
							>
								<Smartphone aria-hidden />
								{pairingBusy ? "Creating code…" : "Show mobile QR"}
							</Button>
							<Button
								size="xs"
								onClick={() => void startPairing("browser")}
								disabled={pairingBusy}
							>
								<Monitor aria-hidden />
								{pairingBusy ? "Creating link…" : "Create web link"}
							</Button>
						</>
					) : (
						<Button
							size="xs"
							onClick={() => setPendingNetworkMode(true)}
							disabled={busy}
						>
							Enable browser and device access
						</Button>
					)}
				</FrameFooter>
			</Frame>

			{pairing !== null && (
				<Frame>
					<FramePanel className="grid gap-3 p-3 sm:grid-cols-[132px_1fr]">
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
							<div>
								<FrameTitle>
									{pairingTarget === "browser"
										? "Connect a web browser"
										: "Connect the mobile app"}
								</FrameTitle>
								<p className="mt-1 text-xs text-muted-foreground">
									This one-time link expires in five minutes. Access remains
									until you revoke the connected device below.
								</p>
							</div>
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
					</FramePanel>
				</Frame>
			)}

			{hasActiveTokens && (
				<Frame>
					<FramePanel className="space-y-2.5 p-2.5">
						<FrameTitle>{deviceAccessCopy.pairedTitle}</FrameTitle>
						<div className="flex flex-col gap-2">
							{identifiedDevices.map((token) => (
								<div
									key={token.id}
									className="flex min-h-11 items-center gap-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-2"
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
										<p className="truncate text-sm font-medium">
											{token.label ??
												(accessDeviceKind(token) === "browser"
													? "Web browser"
													: "Mobile device")}
										</p>
										<p className="text-xs text-muted-foreground">
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
								<div className="flex min-h-11 items-center gap-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
									<Smartphone
										className="size-4 shrink-0 text-muted-foreground"
										aria-hidden
									/>
									<div className="min-w-0 flex-1">
										<p className="truncate text-sm font-medium">
											Older device access
										</p>
										<p className="text-xs text-muted-foreground">
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
					</FramePanel>
				</Frame>
			)}

			<Frame>
				<FramePanel className="space-y-2.5 p-2.5">
					<div className="flex items-center gap-2">
						<span
							className={
								remoteReady
									? "size-2 rounded-full bg-emerald-500"
									: "size-2 rounded-full bg-muted-foreground/40"
							}
							aria-hidden
						/>
						<FrameTitle>{deviceAccessCopy.remoteTitle}</FrameTitle>
					</div>
					{linked ? (
						<p className="text-xs text-muted-foreground">
							{remoteReady
								? `Ready. Use ${status?.label ?? "this computer"} from a browser or mobile device away from this Wi-Fi.`
								: "Linked to your account. Remote access will resume when this computer reconnects."}
						</p>
					) : (
						<>
							<p className="text-xs text-muted-foreground">
								Optional. Sign in to reach this environment from a browser or
								mobile device away from this Wi-Fi.
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
					<p className="text-[11px] text-muted-foreground/80">
						Headless machine? Run <code>zuse serve</code> there. It becomes a
						separate environment and prints its own web link.
					</p>
				</FramePanel>
				<FrameFooter className="flex justify-end px-2.5 py-2">
					<Button
						size="xs"
						variant={linked ? "destructive-outline" : "default"}
						onClick={() => void (linked ? unlinkRelay() : connectRelay())}
						disabled={busy}
					>
						{linked
							? "Turn off remote access"
							: busy
								? "Connecting…"
								: "Set up remote access"}
					</Button>
				</FrameFooter>
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
