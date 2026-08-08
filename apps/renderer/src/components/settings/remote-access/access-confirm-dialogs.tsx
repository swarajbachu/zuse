import type { TailnetShareState } from "@zuse/contracts";

import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "../../ui/alert-dialog.tsx";
import { Button } from "../../ui/button.tsx";

export type AccessDialog =
	| "serve-enable"
	| "serve-disable"
	| "tailscale-enable"
	| "tailscale-disable"
	| null;

/**
 * Confirmation dialogs for turning access surfaces on/off: Zuse Serve,
 * Tailscale Serve, and the local-network listener (which restarts the app).
 */
export function AccessConfirmDialogs({
	accessDialog,
	onAccessDialogOpenChange,
	onConfirmAccess,
	pendingNetworkMode,
	onNetworkDialogOpenChange,
	onConfirmNetwork,
	busy,
	tailnetBusy,
	tailnet,
}: {
	readonly accessDialog: AccessDialog;
	readonly onAccessDialogOpenChange: (open: boolean) => void;
	readonly onConfirmAccess: () => void;
	readonly pendingNetworkMode: boolean | null;
	readonly onNetworkDialogOpenChange: (open: boolean) => void;
	readonly onConfirmNetwork: () => void;
	readonly busy: boolean;
	readonly tailnetBusy: boolean;
	readonly tailnet: TailnetShareState | null;
}) {
	return (
		<>
			<AlertDialog
				open={accessDialog !== null}
				onOpenChange={onAccessDialogOpenChange}
			>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{accessDialog === "serve-enable"
								? "Set up Zuse Serve?"
								: accessDialog === "serve-disable"
									? "Turn off Zuse Serve?"
									: accessDialog === "tailscale-enable"
										? "Share Zuse Serve through Tailscale?"
										: "Turn off Tailscale access?"}
						</AlertDialogTitle>
						<AlertDialogDescription render={<div />}>
							<div className="space-y-2">
								<p>
									{accessDialog === "serve-enable"
										? "Zuse Serve makes this computer available to your signed-in devices through an encrypted outbound connection."
										: accessDialog === "serve-disable"
											? "Devices that rely on internet access will disconnect. Tailscale and local-network access will keep working if enabled."
											: accessDialog === "tailscale-enable"
												? "This uses Tailscale Serve to make Zuse available only to devices on your tailnet. Tailscale must be installed and signed in."
												: "Devices using the private tailnet address will disconnect. Other enabled access methods will keep working."}
								</p>
								{accessDialog === "serve-enable" ? (
									<p>
										No router ports are opened. The connection stays available
										after restart until you turn it off.
									</p>
								) : null}
								{accessDialog === "tailscale-enable" ? (
									<p>
										Tailscale may open your browser once to approve Serve. This
										does not expose Zuse to the public internet.
									</p>
								) : null}
							</div>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose
							render={
								<Button variant="outline" disabled={busy || tailnetBusy} />
							}
						>
							Cancel
						</AlertDialogClose>
						<Button
							variant={
								accessDialog === "serve-disable" ||
								accessDialog === "tailscale-disable"
									? "destructive"
									: "default"
							}
							disabled={busy || tailnetBusy}
							onClick={onConfirmAccess}
						>
							{busy || tailnetBusy
								? "Updating…"
								: accessDialog === "serve-enable"
									? "Set up Zuse Serve"
									: accessDialog === "serve-disable"
										? "Turn off Zuse Serve"
										: accessDialog === "tailscale-enable"
											? tailnet?.availability === "not-installed"
												? "Install Tailscale"
												: "Enable Tailscale"
											: "Turn off Tailscale"}
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>

			<AlertDialog
				open={pendingNetworkMode !== null}
				onOpenChange={onNetworkDialogOpenChange}
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
							onClick={onConfirmNetwork}
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
		</>
	);
}
