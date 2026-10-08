import "@zuse/i18n/english/settings";
import type {
	ApiLinkStatus,
	NetworkAccessState,
	TailnetShareState,
} from "@zuse/contracts";
import { RichMessage, useMessages as useUiMessages } from "@zuse/i18n/react";
import { Server, ShieldCheck, Wifi } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
	accountPairingEndpoint,
	tailnetStatusLine,
} from "../../../lib/remote-access.ts";
import { Button } from "../../ui/button.tsx";
import { Card } from "../../ui/card.tsx";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPopup,
	DialogTitle,
} from "../../ui/dialog.tsx";
import { Frame } from "../../ui/frame.tsx";
import { RemoteAccessSectionHeader } from "./section-header.tsx";

function AccessMethodRow({
	icon,
	title,
	description,
	action,
}: {
	readonly icon: ReactNode;
	readonly title: string;
	readonly description: ReactNode;
	readonly action: ReactNode;
}) {
	return (
		<div className="flex min-h-14 items-center gap-2.5 px-3 py-2">
			<div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
				{icon}
			</div>
			<div className="min-w-0 flex-1">
				<p className="text-xs font-medium">{title}</p>
				<p className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground">
					{description}
				</p>
			</div>
			<div className="flex min-h-11 shrink-0 items-center">{action}</div>
		</div>
	);
}

/**
 * Keeps Zuse Serve as the primary action and presents private/local access as
 * compact alternatives. Pairing credentials are handled separately.
 */
export function AccessMethodsCard({
	status,
	tailnet,
	network,
	networkEnabled,
	canManageNetwork,
	busy,
	tailnetBusy,
	onOpenAccessDialog,
	onRequestNetworkMode,
}: {
	readonly status: ApiLinkStatus | null;
	readonly tailnet: TailnetShareState | null;
	readonly network: NetworkAccessState | null;
	readonly networkEnabled: boolean;
	readonly canManageNetwork: boolean;
	readonly busy: boolean;
	readonly tailnetBusy: boolean;
	readonly onOpenAccessDialog: (
		dialog:
			| "serve-enable"
			| "serve-disable"
			| "tailscale-enable"
			| "tailscale-disable",
	) => void;
	readonly onRequestNetworkMode: (enabled: boolean) => void;
}) {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const [serveDetailsOpen, setServeDetailsOpen] = useState(false);

	// Zuse Serve row.
	const linked = status?.linked === true;
	const remoteReady = linked && status?.heartbeatActive === true;
	const accountEndpoint = accountPairingEndpoint(status);
	const accountAddress = (() => {
		if (accountEndpoint === undefined) return null;
		try {
			return new URL(accountEndpoint.httpBaseUrl).host;
		} catch {
			return accountEndpoint.httpBaseUrl;
		}
	})();
	const accountShareReady = remoteReady && accountAddress !== null;

	// Tailscale row.
	const line = tailnetStatusLine(tailnet);
	const tailnetManaged = tailnet?.managedBy === "zuse-serve";
	const tailnetConflict =
		tailnet?.availability === "conflict" && tailnet.conflict !== null;
	const tailscaleShareReady =
		tailnet?.enabled === true && tailnet.dnsName !== null && !tailnetManaged;

	// Local network row.
	const networkAddress =
		network?.advertisedHost != null && network.port != null
			? `${network.advertisedHost}:${network.port}`
			: (network?.endpointUrl ?? null);

	const tailnetAction = (() => {
		if (line.action === null) return null;
		if (line.action === "details") {
			return (
				<Button
					size="xs"
					variant="ghost"
					onClick={() => setServeDetailsOpen(true)}
				>
					{uiMessage("settings:access_methods_card_details")}
				</Button>
			);
		}
		return (
			<Button
				size="xs"
				variant={tailscaleShareReady ? "ghost" : "outline"}
				disabled={tailnetBusy || tailnetManaged || tailnetConflict}
				onClick={() =>
					onOpenAccessDialog(
						tailscaleShareReady ? "tailscale-disable" : "tailscale-enable",
					)
				}
			>
				{tailnetBusy
					? uiMessage("settings:access_methods_card_updating")
					: tailscaleShareReady
						? uiMessage("settings:access_methods_card_turn_off")
						: uiMessage("settings:access_methods_card_set_up")}
			</Button>
		);
	})();

	return (
		<Frame>
			<RemoteAccessSectionHeader
				title={uiMessage("settings:access_methods_card_connections")}
				tooltip={uiMessage(
					"settings:access_methods_card_choose_how_other_zuse_apps_and_browsers_can_reach_this_computer",
				)}
				className="pt-1.5 pb-2"
			/>
			<Card className="overflow-hidden">
				<div className="flex flex-col divide-y divide-border/40">
					<AccessMethodRow
						icon={<Server className="size-4" aria-hidden />}
						title={uiMessage("settings:access_methods_card_zuse_serve")}
						description={
							accountShareReady && accountAddress !== null
								? uiMessage("settings:access_methods_card_available_anywhere", {
										accountAddress: String(accountAddress),
									})
								: linked
									? uiMessage(
											"settings:access_methods_card_reconnecting_to_your_account",
										)
									: uiMessage(
											"settings:access_methods_card_access_this_computer_from_your_signed_in_devices",
										)
						}
						action={
							<Button
								size="xs"
								variant={linked ? "ghost" : "outline"}
								disabled={busy}
								onClick={() =>
									onOpenAccessDialog(linked ? "serve-disable" : "serve-enable")
								}
							>
								{busy
									? uiMessage("settings:access_methods_card_updating")
									: linked
										? uiMessage("settings:access_methods_card_turn_off")
										: uiMessage("settings:access_methods_card_set_up")}
							</Button>
						}
					/>
					<AccessMethodRow
						icon={<ShieldCheck className="size-4" aria-hidden />}
						title={uiMessage("settings:access_methods_card_tailscale")}
						description={
							tailscaleShareReady && tailnet?.dnsName !== null
								? uiMessage("settings:access_methods_card_private_access", {
										dnsName: String(tailnet.dnsName),
									})
								: line.description
						}
						action={tailnetAction}
					/>
					<AccessMethodRow
						icon={<Wifi className="size-4" aria-hidden />}
						title={uiMessage("settings:access_methods_card_local_network")}
						description={
							networkEnabled && networkAddress !== null
								? uiMessage(
										"settings:access_methods_card_available_on_this_network",
										{ networkAddress: String(networkAddress) },
									)
								: !canManageNetwork
									? uiMessage(
											"settings:access_methods_card_available_in_the_desktop_app",
										)
									: uiMessage(
											"settings:access_methods_card_connect_from_another_device_on_the_same_wi_fi",
										)
						}
						action={
							<Button
								size="xs"
								variant={networkEnabled ? "ghost" : "outline"}
								disabled={busy || !canManageNetwork}
								onClick={() => onRequestNetworkMode(!networkEnabled)}
							>
								{networkEnabled
									? uiMessage("settings:access_methods_card_turn_off")
									: uiMessage("settings:access_methods_card_turn_on")}
							</Button>
						}
					/>
				</div>
			</Card>

			<Dialog open={serveDetailsOpen} onOpenChange={setServeDetailsOpen}>
				<DialogPopup className="max-w-sm">
					<DialogHeader>
						<DialogTitle>
							{uiMessage("settings:access_methods_card_managed_by_zuse_serve")}
						</DialogTitle>
						<DialogDescription>
							<RichMessage
								id="settings:access_methods_card_the_zuse_serve_daemon_on_this_computer_owns_the_tailscale_se_sentence"
								components={{ part0: <code />, part1: <code /> }}
								values={{ code0: "zuse serve", code1: "zuse serve --stop" }}
							/>
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button onClick={() => setServeDetailsOpen(false)}>
							{uiMessage("common:done")}
						</Button>
					</DialogFooter>
				</DialogPopup>
			</Dialog>
		</Frame>
	);
}
