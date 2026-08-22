import type {
	AuthTokenSummary,
	PairingStartResult,
	RelayLinkStatus,
	TailnetShareState,
} from "@zuse/contracts";
import { formatPairingCodeForDisplay } from "@zuse/contracts";
import { Copy, QrCode, RefreshCw } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import { dispatchLocalDeviceCommand } from "../../../lib/local-device-client-bus.ts";
import { accessDeviceKind } from "../../../lib/paired-phones.ts";
import { copyText } from "../../../lib/platform-capabilities.ts";
import {
	type PairingMethod,
	pairingForMethod,
	readyMethods,
} from "../../../lib/remote-access.ts";
import { Button } from "../../ui/button.tsx";
import { Card } from "../../ui/card.tsx";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "../../ui/dialog.tsx";
import { Frame } from "../../ui/frame.tsx";
import { Input } from "../../ui/input.tsx";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "../../ui/select.tsx";
import { toastManager } from "../../ui/toast.tsx";
import { messageForError, showError } from "./access-errors.ts";
import { RemoteAccessSectionHeader } from "./section-header.tsx";

const METHOD_LABEL: Record<PairingMethod, string> = {
	account: "Zuse Serve",
	tailscale: "Tailscale",
	local: "Local network",
};

const METHOD_STATUS: Record<PairingMethod, string> = {
	account: "Works anywhere · via Zuse Serve",
	tailscale: "Same tailnet only · via Tailscale",
	local: "Same Wi-Fi only · via local network",
};

const formatRemaining = (remainingMs: number): string => {
	const clamped = Math.max(remainingMs, 0);
	const minutes = Math.floor(clamped / 60_000);
	const seconds = Math.floor((clamped % 60_000) / 1_000);
	return `${minutes}m ${String(seconds).padStart(2, "0")}s left`;
};

/**
 * Creates a short-lived pairing credential only while the focused dialog is
 * open. Switching connection methods reuses the same server authorization
 * against a different advertised endpoint.
 */
export function ConnectLinkCard({
	status,
	tailnet,
	networkEnabled,
	tokens,
	onTokens,
}: {
	readonly status: RelayLinkStatus | null;
	readonly tailnet: TailnetShareState | null;
	readonly networkEnabled: boolean;
	readonly tokens: ReadonlyArray<AuthTokenSummary>;
	readonly onTokens: (tokens: ReadonlyArray<AuthTokenSummary>) => void;
}) {
	const [pairing, setPairing] = useState<PairingStartResult | null>(null);
	const [method, setMethod] = useState<PairingMethod>("account");
	const [dialogOpen, setDialogOpen] = useState(false);
	const [starting, setStarting] = useState(false);
	const [qrOpen, setQrOpen] = useState(false);
	const [connectedLabel, setConnectedLabel] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [remainingMs, setRemainingMs] = useState<number | null>(null);
	const startingRef = useRef(false);
	const dialogOpenRef = useRef(false);
	const knownTokenIdsRef = useRef<ReadonlySet<string>>(new Set());
	const tokensRef = useRef(tokens);

	useEffect(() => {
		tokensRef.current = tokens;
	}, [tokens]);

	const ready = readyMethods({ status, tailnet, networkEnabled });
	const anyReady = ready.length > 0;

	const start = useCallback(async () => {
		if (startingRef.current) return;
		startingRef.current = true;
		setStarting(true);
		setPairing(null);
		setErrorMessage(null);
		try {
			knownTokenIdsRef.current = new Set(
				tokensRef.current
					.filter((token) => token.revokedAt === undefined)
					.map((token) => token.id),
			);
			const next = await dispatchLocalDeviceCommand<
				Record<never, never>,
				PairingStartResult
			>("pairing.start", {});
			if (dialogOpenRef.current) setPairing(next);
		} catch (cause) {
			setErrorMessage(messageForError(cause));
		} finally {
			startingRef.current = false;
			setStarting(false);
		}
	}, []);

	// Stop presenting a link if its selected route is no longer reachable.
	useEffect(() => {
		if (!anyReady) {
			setPairing(null);
			setRemainingMs(null);
			setDialogOpen(false);
		}
	}, [anyReady]);

	// Snap to the best ready method when the current one loses readiness.
	useEffect(() => {
		const best = ready[0];
		if (best === undefined || ready.includes(method)) return;
		setMethod(best);
	}, [ready, method]);

	// Live countdown; a fresh code is minted in place on expiry.
	useEffect(() => {
		if (pairing === null) return;
		const update = () =>
			setRemainingMs(pairing.expiresAt.getTime() - Date.now());
		update();
		const ticker = setInterval(update, 1_000);
		const renew = setTimeout(
			() => void start(),
			Math.max(pairing.expiresAt.getTime() - Date.now(), 0),
		);
		return () => {
			clearInterval(ticker);
			clearTimeout(renew);
		};
	}, [pairing, start]);

	// Notice when a device redeems the outstanding code.
	useEffect(() => {
		if (pairing === null) return;
		const checkForPairedDevice = async () => {
			try {
				const next = await dispatchLocalDeviceCommand<
					Record<never, never>,
					ReadonlyArray<AuthTokenSummary>
				>("pairing.listTokens", {});
				onTokens(next);
				const active = next.filter((token) => token.revokedAt === undefined);
				const paired = active.find(
					(token) => !knownTokenIdsRef.current.has(token.id),
				);
				if (paired !== undefined) {
					setConnectedLabel(
						paired.label ??
							(accessDeviceKind(paired) === "browser"
								? "Web browser"
								: "Mobile device"),
					);
					// Re-arm so a second device pairing is detected too.
					knownTokenIdsRef.current = new Set(active.map((token) => token.id));
				}
			} catch {
				// Transient; retry on the next poll.
			}
		};
		const timer = setInterval(() => void checkForPairedDevice(), 1_500);
		return () => clearInterval(timer);
	}, [pairing, onTokens]);

	const activePairing =
		pairing === null
			? null
			: pairingForMethod(pairing, method, status, tailnet);
	const qrText = activePairing?.qrText ?? "";
	const browserUrl = activePairing?.browserUrl ?? "";
	const pairingCode =
		activePairing === null
			? ""
			: formatPairingCodeForDisplay(activePairing.code);

	const copyBrowserUrl = useCallback(async () => {
		if (browserUrl === "") return;
		try {
			await copyText(browserUrl);
			toastManager.add({
				title: "Connect link copied",
				description: "Open it in a browser or paste it into Add Computer.",
			});
		} catch (cause) {
			showError("Could not copy the connect link", cause);
		}
	}, [browserUrl]);

	const copyCode = useCallback(async () => {
		if (pairingCode === "") return;
		try {
			await copyText(pairingCode);
			toastManager.add({
				title: "Pairing code copied",
				description: "Enter it in the browser within five minutes.",
			});
		} catch (cause) {
			showError("Could not copy the pairing code", cause);
		}
	}, [pairingCode]);

	const openDialog = useCallback(() => {
		const best = ready[0];
		if (best === undefined) return;
		setMethod(best);
		setConnectedLabel(null);
		setQrOpen(false);
		dialogOpenRef.current = true;
		setDialogOpen(true);
		void start();
	}, [ready, start]);

	const closeDialog = useCallback(() => {
		dialogOpenRef.current = false;
		setDialogOpen(false);
		setPairing(null);
		setQrOpen(false);
		setRemainingMs(null);
	}, []);

	return (
		<>
			<Frame>
				<RemoteAccessSectionHeader
					title="Connect another device"
					tooltip="Create a temporary link that authorizes another Zuse app or browser to use this computer."
				/>
				<Card>
					<div className="flex min-h-14 items-center gap-2.5 px-3 py-2">
						<div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
							<Link2 className="size-4" aria-hidden />
						</div>
						<div className="min-w-0 flex-1">
							<p className="text-xs font-medium">Create a connect link</p>
							<p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
								{anyReady
									? "Authorize another device with a link that lasts five minutes."
									: "Set up one of the connections above first."}
							</p>
						</div>
						<Button size="xs" disabled={!anyReady} onClick={openDialog}>
							Create link
						</Button>
					</div>
				</Card>
			</Frame>

			<Dialog
				open={dialogOpen}
				onOpenChange={(open) => {
					if (open) {
						dialogOpenRef.current = true;
						setDialogOpen(true);
					} else closeDialog();
				}}
			>
				<DialogPopup className="max-w-md">
					<DialogHeader>
						<DialogTitle>Connect another device</DialogTitle>
						<DialogDescription>
							Open this link in a browser, paste it into Add Computer, or scan
							the QR code. Choose which connection it should use.
						</DialogDescription>
					</DialogHeader>
					<DialogPanel className="space-y-3">
						<div>
							<label
								htmlFor="connect-link-method"
								className="mb-1 block text-[11px] font-medium"
							>
								Connect through
							</label>
							<Select
								value={method}
								onValueChange={(value) => setMethod(value as PairingMethod)}
							>
								<SelectTrigger id="connect-link-method">
									<SelectValue />
								</SelectTrigger>
								<SelectPopup>
									{ready.map((item) => (
										<SelectItem key={item} value={item}>
											{METHOD_LABEL[item]}
										</SelectItem>
									))}
								</SelectPopup>
							</Select>
						</div>

						{errorMessage !== null ? (
							<div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
								<p role="alert" className="flex-1 text-[11px] text-destructive">
									{errorMessage}
								</p>
								<Button
									size="xs"
									variant="outline"
									onClick={() => void start()}
								>
									Retry
								</Button>
							</div>
						) : (
							<>
								<div className="space-y-2">
									<div className="flex items-center gap-1.5">
										<Input
											readOnly
											aria-label="Connect link"
											className="min-w-0 flex-1 font-mono text-[11px]"
											value={browserUrl}
											placeholder={starting ? "Finding browser address…" : ""}
											onFocus={(event) => event.currentTarget.select()}
										/>
										<Button
											size="xs"
											disabled={activePairing === null || starting}
											onClick={() => void copyBrowserUrl()}
										>
											<Copy aria-hidden />
											Copy link
										</Button>
									</div>
									<div className="flex items-center gap-1.5">
										<Input
											readOnly
											aria-label="Pairing code"
											className="min-w-0 flex-1 font-mono text-sm tracking-wider"
											value={pairingCode}
											placeholder={starting ? "Creating code…" : ""}
											onFocus={(event) => event.currentTarget.select()}
										/>
										<Button
											size="xs"
											disabled={activePairing === null || starting}
											onClick={() => void copyCode()}
										>
											<Copy aria-hidden />
											Copy code
										</Button>
									</div>
								</div>
								<div className="flex items-center justify-between gap-2">
									<p
										aria-live="polite"
										className="text-[11px] leading-4 text-muted-foreground"
									>
										{connectedLabel !== null
											? `Connected — ${connectedLabel} can now use this computer.`
											: METHOD_STATUS[method]}
									</p>
									{remainingMs !== null ? (
										<span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
											{formatRemaining(remainingMs)}
										</span>
									) : null}
								</div>
								{qrOpen && qrText !== "" ? (
									<div className="flex justify-center py-1">
										<div
											className="flex size-[148px] items-center justify-center rounded-lg bg-white p-2.5"
											role="img"
											aria-label="Connect QR code"
										>
											<QRCodeSVG value={qrText} size={128} level="M" />
										</div>
									</div>
								) : null}
							</>
						)}
					</DialogPanel>
					<DialogFooter>
						<Button
							variant="ghost"
							disabled={qrText === ""}
							onClick={() => setQrOpen((current) => !current)}
						>
							<QrCode aria-hidden />
							{qrOpen ? "Hide QR" : "Show QR"}
						</Button>
						<Button
							variant="outline"
							disabled={starting}
							onClick={() => void start()}
						>
							<RefreshCw aria-hidden />
							New link
						</Button>
						<Button onClick={closeDialog}>Done</Button>
					</DialogFooter>
				</DialogPopup>
			</Dialog>
		</>
	);
}
