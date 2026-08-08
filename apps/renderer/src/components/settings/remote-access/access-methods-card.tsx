import type {
	NetworkAccessState,
	RelayLinkStatus,
	TailnetShareState,
} from "@zuse/contracts";
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
	readonly status: RelayLinkStatus | null;
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
					Details
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
					? "Updating…"
					: tailscaleShareReady
						? "Turn off"
						: "Set up"}
			</Button>
		);
	})();

	return (
		<Frame>
			<RemoteAccessSectionHeader
				title="Connections"
				tooltip="Choose how other Zuse apps and browsers can reach this computer."
				className="pt-1.5 pb-2"
			/>
			<Card className="overflow-hidden">
				<div className="flex flex-col divide-y divide-border/40">
					<AccessMethodRow
						icon={<Server className="size-4" aria-hidden />}
						title="Zuse Serve"
						description={
							accountShareReady && accountAddress !== null
								? `Available anywhere · ${accountAddress}`
								: linked
									? "Reconnecting to your account…"
									: "Access this computer from your signed-in devices."
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
								{busy ? "Updating…" : linked ? "Turn off" : "Set up"}
							</Button>
						}
					/>
					<AccessMethodRow
						icon={<ShieldCheck className="size-4" aria-hidden />}
						title="Tailscale"
						description={
							tailscaleShareReady && tailnet?.dnsName !== null
								? `Private access · ${tailnet.dnsName}`
								: line.description
						}
						action={tailnetAction}
					/>
					<AccessMethodRow
						icon={<Wifi className="size-4" aria-hidden />}
						title="Local network"
						description={
							networkEnabled && networkAddress !== null
								? `Available on this network · ${networkAddress}`
								: !canManageNetwork
									? "Available in the desktop app."
									: "Connect from another device on the same Wi-Fi."
						}
						action={
							<Button
								size="xs"
								variant={networkEnabled ? "ghost" : "outline"}
								disabled={busy || !canManageNetwork}
								onClick={() => onRequestNetworkMode(!networkEnabled)}
							>
								{networkEnabled ? "Turn off" : "Turn on"}
							</Button>
						}
					/>
				</div>
			</Card>

			<Dialog open={serveDetailsOpen} onOpenChange={setServeDetailsOpen}>
				<DialogPopup className="max-w-sm">
					<DialogHeader>
						<DialogTitle>Managed by zuse serve</DialogTitle>
						<DialogDescription>
							The <code>zuse serve</code> daemon on this computer owns the
							Tailscale Serve route. To change or turn off Tailscale access
							here, run <code>zuse serve --stop</code> on this computer first.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button onClick={() => setServeDetailsOpen(false)}>Done</Button>
					</DialogFooter>
				</DialogPopup>
			</Dialog>
		</Frame>
	);
}
