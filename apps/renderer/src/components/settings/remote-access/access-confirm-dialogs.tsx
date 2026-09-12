import "@zuse/i18n/english/settings";
import type { TailnetShareState } from "@zuse/contracts";
import { useMessages as useUiMessages } from "@zuse/i18n/react";

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
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

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
								? uiMessage("settings:access_confirm_dialogs_set_up_zuse_serve")
								: accessDialog === "serve-disable"
									? uiMessage(
											"settings:access_confirm_dialogs_turn_off_zuse_serve",
										)
									: accessDialog === "tailscale-enable"
										? uiMessage(
												"settings:access_confirm_dialogs_share_zuse_serve_through_tailscale",
											)
										: uiMessage(
												"settings:access_confirm_dialogs_turn_off_tailscale_access",
											)}
						</AlertDialogTitle>
						<AlertDialogDescription render={<div />}>
							<div className="space-y-2">
								<p>
									{accessDialog === "serve-enable"
										? uiMessage(
												"settings:access_confirm_dialogs_zuse_serve_makes_this_computer_available_to_your_signed_in_devices_thr",
											)
										: accessDialog === "serve-disable"
											? uiMessage(
													"settings:access_confirm_dialogs_devices_that_rely_on_internet_access_will_disconnect_tailscale_and_loc",
												)
											: accessDialog === "tailscale-enable"
												? uiMessage(
														"settings:access_confirm_dialogs_this_uses_tailscale_serve_to_make_zuse_available_only_to_devices_on_yo",
													)
												: uiMessage(
														"settings:access_confirm_dialogs_devices_using_the_private_tailnet_address_will_disconnect_other_enable",
													)}
								</p>
								{accessDialog === "serve-enable" ? (
									<p>
										{uiMessage(
											"settings:access_confirm_dialogs_no_router_ports_are_opened_the_connection_stays_available_after_restar",
										)}
									</p>
								) : null}
								{accessDialog === "tailscale-enable" ? (
									<p>
										{uiMessage(
											"settings:access_confirm_dialogs_tailscale_may_open_your_browser_once_to_approve_serve_this_does_not_ex",
										)}
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
							{uiMessage("common:cancel")}
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
								? uiMessage("settings:access_confirm_dialogs_updating")
								: accessDialog === "serve-enable"
									? uiMessage(
											"settings:access_confirm_dialogs_set_up_zuse_serve_2",
										)
									: accessDialog === "serve-disable"
										? uiMessage(
												"settings:access_confirm_dialogs_turn_off_zuse_serve_2",
											)
										: accessDialog === "tailscale-enable"
											? tailnet?.availability === "not-installed"
												? uiMessage(
														"settings:access_confirm_dialogs_install_tailscale",
													)
												: uiMessage(
														"settings:access_confirm_dialogs_enable_tailscale",
													)
											: uiMessage(
													"settings:access_confirm_dialogs_turn_off_tailscale",
												)}
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
								? uiMessage(
										"settings:access_confirm_dialogs_turn_on_local_access",
									)
								: uiMessage(
										"settings:access_confirm_dialogs_turn_off_local_access",
									)}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingNetworkMode
								? uiMessage(
										"settings:access_confirm_dialogs_the_app_will_restart_so_browsers_and_mobile_devices_can_connect_over_t",
									)
								: uiMessage(
										"settings:access_confirm_dialogs_the_app_will_restart_and_connected_browsers_and_mobile_devices_on_this",
									)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose
							render={<Button variant="outline" disabled={busy} />}
						>
							{uiMessage("common:cancel")}
						</AlertDialogClose>
						<Button
							variant={pendingNetworkMode ? "default" : "destructive"}
							onClick={onConfirmNetwork}
							disabled={busy}
						>
							{busy
								? uiMessage("settings:access_confirm_dialogs_restarting")
								: pendingNetworkMode
									? uiMessage(
											"settings:access_confirm_dialogs_restart_and_turn_on",
										)
									: uiMessage(
											"settings:access_confirm_dialogs_restart_and_turn_off",
										)}
						</Button>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</>
	);
}
