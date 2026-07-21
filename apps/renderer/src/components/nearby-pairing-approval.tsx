import type { NearbyPairingRequest } from "@zuse/contracts";
import { Effect } from "effect";
import { Smartphone } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { recordDiagnosticEvent } from "../lib/diagnostics-recorder.ts";
import { getRpcClient } from "../lib/rpc-client.ts";
import {
	AlertDialog,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button.tsx";
import { toastManager } from "./ui/toast.tsx";

const POLL_INTERVAL_MS = 1_000;

const safetyPhraseLabel = (phrase: string): string =>
	phrase.split("-").join("  ·  ");

const logPairingEvent = (message: string, requestId?: string): void => {
	const detail =
		requestId === undefined ? undefined : JSON.stringify({ requestId });
	console.info(`[zuse:pairing] ${message}`, detail ?? "");
	recordDiagnosticEvent({
		level: "info",
		source: "renderer.pairing",
		message,
		detail,
	});
};

export function NearbyPairingApproval() {
	const [request, setRequest] = useState<NearbyPairingRequest | null>(null);
	const [busy, setBusy] = useState(false);
	const refreshFailureLogged = useRef(false);
	const lastObservedRequestId = useRef<string | null>(null);
	const lastOpenedRequestId = useRef<string | null>(null);

	const refresh = useCallback(async () => {
		const client = await getRpcClient();
		const requests = await Effect.runPromise(
			client["pairing.listNearbyRequests"]({}),
		);
		const next = requests[0];
		if (
			next !== undefined &&
			lastObservedRequestId.current !== next.requestId
		) {
			lastObservedRequestId.current = next.requestId;
			logPairingEvent("renderer.fallback.request_found", next.requestId);
		}
		setRequest((current) => {
			if (next !== undefined) return next;
			if (current !== null && current.expiresAt.getTime() > Date.now()) {
				return current;
			}
			return null;
		});
		refreshFailureLogged.current = false;
	}, []);

	const refreshSafely = useCallback(async () => {
		try {
			await refresh();
		} catch (cause) {
			if (refreshFailureLogged.current) return;
			refreshFailureLogged.current = true;
			console.error("[zuse:pairing] Could not refresh nearby requests", cause);
		}
	}, [refresh]);

	useEffect(() => {
		const pairingBridge = window.zuse?.pairing;
		logPairingEvent(
			pairingBridge === undefined
				? "renderer.subscription.unavailable"
				: "renderer.subscription.installed",
		);
		const removePush = pairingBridge?.onNearbyRequest((next) => {
			lastObservedRequestId.current = next.requestId;
			logPairingEvent("renderer.push.request_received", next.requestId);
			setRequest(next);
		});
		void refreshSafely();
		const timer = window.setInterval(() => {
			void refreshSafely();
		}, POLL_INTERVAL_MS);
		return () => {
			removePush?.();
			window.clearInterval(timer);
		};
	}, [refreshSafely]);

	useEffect(() => {
		if (request !== null && lastOpenedRequestId.current !== request.requestId) {
			lastOpenedRequestId.current = request.requestId;
			logPairingEvent("renderer.dialog.opened", request.requestId);
		}
	}, [request]);

	const decide = useCallback(
		async (decision: "allow" | "deny" | "block") => {
			if (request === null || busy) return;
			setBusy(true);
			try {
				const client = await getRpcClient();
				await Effect.runPromise(
					client["pairing.resolveNearbyRequest"]({
						requestId: request.requestId,
						decision,
					}),
				);
				setRequest(null);
			} catch (cause) {
				toastManager.add({
					type: "error",
					title: "Could not update phone access",
					description:
						cause instanceof Error ? cause.message : "Please try again.",
				});
			} finally {
				setBusy(false);
			}
		},
		[busy, request],
	);

	return (
		<AlertDialog
			open={request !== null}
			onOpenChange={(open) => {
				if (!open && !busy) void decide("deny");
			}}
		>
			<AlertDialogPopup className="max-w-sm">
				<AlertDialogHeader>
					<div className="mb-1 flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
						<Smartphone className="size-5" aria-hidden />
					</div>
					<AlertDialogTitle>Is this you trying to connect?</AlertDialogTitle>
					<AlertDialogDescription>
						Confirm these words match the ones shown on your phone.
					</AlertDialogDescription>
					{request === null ? null : (
						<div className="mt-3 rounded-xl border border-border/60 bg-muted/30 p-3.5">
							<p className="text-sm font-medium">{request.deviceLabel}</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								{request.deviceModel ?? "iPhone"} · Device{" "}
								{request.deviceIdentifier}
							</p>
							<code className="mt-3 block font-semibold text-base tracking-tight tabular-nums">
								{safetyPhraseLabel(request.safetyPhrase)}
							</code>
						</div>
					)}
				</AlertDialogHeader>
				<AlertDialogFooter className="items-center">
					<Button
						variant="ghost"
						className="sm:mr-auto"
						onClick={() => void decide("block")}
						disabled={busy}
					>
						Block device
					</Button>
					<Button
						variant="outline"
						onClick={() => void decide("deny")}
						disabled={busy}
					>
						Not now
					</Button>
					<Button onClick={() => void decide("allow")} disabled={busy}>
						{busy ? "Allowing…" : "Allow"}
					</Button>
				</AlertDialogFooter>
			</AlertDialogPopup>
		</AlertDialog>
	);
}
