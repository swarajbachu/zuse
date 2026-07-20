import type { NearbyPairingRequest } from "@zuse/contracts";
import { Effect } from "effect";
import { Smartphone } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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

export function NearbyPairingApproval() {
	const [request, setRequest] = useState<NearbyPairingRequest | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		const client = await getRpcClient();
		const requests = await Effect.runPromise(
			client["pairing.listNearbyRequests"]({}),
		);
		setRequest(requests[0] ?? null);
	}, []);

	useEffect(() => {
		void refresh().catch(() => undefined);
		const timer = window.setInterval(
			() => void refresh().catch(() => undefined),
			POLL_INTERVAL_MS,
		);
		return () => window.clearInterval(timer);
	}, [refresh]);

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
			<AlertDialogPopup className="max-w-md">
				<AlertDialogHeader>
					<div className="mb-1 flex size-10 items-center justify-center rounded-lg bg-muted">
						<Smartphone className="size-5" aria-hidden />
					</div>
					<AlertDialogTitle>Is this you trying to connect?</AlertDialogTitle>
					<AlertDialogDescription>
						Compare the safety phrase with the one shown on your phone.
					</AlertDialogDescription>
					{request === null ? null : (
						<div className="mt-3 rounded-lg border border-border/60 bg-muted/30 p-3">
							<p className="text-sm font-medium">{request.deviceLabel}</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								{request.deviceModel ?? "iPhone"} · Device{" "}
								{request.deviceIdentifier}
							</p>
							<code className="mt-3 block font-semibold text-base tabular-nums">
								{request.safetyPhrase}
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
