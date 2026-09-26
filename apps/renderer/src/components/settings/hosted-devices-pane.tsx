import "@zuse/i18n/english/settings";
import "@zuse/i18n/english/shell";
import "@zuse/i18n/english/common";
import type {
	ApiEnvironmentRecord,
	ApiEnvironmentStatus,
} from "@zuse/contracts";
import { formatDate } from "@zuse/i18n";
import { useMessages } from "@zuse/i18n/react";
import { Monitor, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useHostedComputers } from "../../hooks/use-hosted-computers.ts";
import { hostedComputerAddress } from "../../lib/hosted-computer-catalog.ts";
import {
	getHostedComputerStatus,
	hostedAccountId,
	removeHostedComputer,
} from "../../lib/hosted-connect.ts";
import {
	forgetHostedLaptop,
	saveHostedLaptopPreference,
} from "../../lib/hosted-laptop-preferences.ts";
import { openExternal } from "../../lib/platform-capabilities.ts";
import { useUiStore } from "../../store/ui.ts";
import { Button } from "../ui/button.tsx";
import { Card } from "../ui/card.tsx";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPopup,
	DialogTitle,
} from "../ui/dialog.tsx";
import { Frame, FrameFooter } from "../ui/frame.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { RemoteAccessSectionHeader } from "./remote-access/section-header.tsx";

/** Browser-owned discovery and setup; device sharing is enabled on the device. */
export function HostedDevicesPane() {
	const { message } = useMessages(["settings", "shell", "common"]);
	const { computers, groups, loading, failed, refresh } = useHostedComputers();
	const [adding, setAdding] = useState(false);
	const [removing, setRemoving] =
		useState<ReadonlyArray<ApiEnvironmentRecord> | null>(null);
	const [busy, setBusy] = useState(false);
	const [removeFailed, setRemoveFailed] = useState(false);
	return (
		<section className="flex flex-col gap-2.5 text-xs">
			<Frame>
				<RemoteAccessSectionHeader
					title={message("settings:using_computers_card_computers")}
					tooltip={message("settings:hosted_remote_description")}
					action={
						<div className="flex gap-1">
							<Button
								className="h-7"
								variant="ghost"
								disabled={loading}
								onClick={refresh}
								aria-label={message("settings:hosted_remote_refresh")}
							>
								<RefreshCw className="size-3.5" />
							</Button>
							<Button className="h-7" onClick={() => setAdding(true)}>
								<Plus className="size-3.5" />
								{message("settings:using_computers_card_add_computer")}
							</Button>
						</div>
					}
				/>
				<Card className="overflow-hidden">
					{loading && computers.length === 0 && (
						<div className="flex justify-center p-3">
							<Spinner />
						</div>
					)}
					{!loading && !failed && computers.length === 0 && (
						<p className="p-3 text-muted-foreground">
							{message("settings:using_computers_card_no_other_computers_yet")}
						</p>
					)}
					{computers.map((computer) => (
						<div
							key={computer.environmentId}
							className="flex items-center gap-2.5 px-3 py-2"
						>
							<Monitor className="size-4 shrink-0 text-muted-foreground" />
							<ComputerDetails
								computer={computer}
								registrations={
									groups.find(
										(group) =>
											group.computer.environmentId === computer.environmentId,
									)?.registrations ?? [computer]
								}
							/>
							<Button
								className="h-7"
								variant="outline"
								onClick={() => {
									saveHostedLaptopPreference(hostedAccountId(), {
										enabled: true,
										environmentId: computer.environmentId,
									});
									window.history.replaceState(null, "", "/");
									useUiStore.getState().setActiveMainTab("chat");
									useUiStore.getState().setView("chat");
								}}
							>
								{message("settings:hosted_remote_show_chats")}
							</Button>
							<Button
								className="h-7"
								variant="ghost"
								aria-label={message("settings:hosted_remote_remove")}
								onClick={() => {
									setRemoveFailed(false);
									setRemoving(
										groups.find(
											(group) =>
												group.computer.environmentId === computer.environmentId,
										)?.registrations ?? [computer],
									);
								}}
							>
								<Trash2 className="size-3.5" />
							</Button>
						</div>
					))}
					{failed && (
						<div
							role="alert"
							className="flex items-center justify-between gap-2 p-3"
						>
							<span>{message("shell:hosted_could_not_load_computers")}</span>
							<Button className="h-7" variant="ghost" onClick={refresh}>
								{message("common:retry")}
							</Button>
						</div>
					)}
				</Card>
				<FrameFooter className="px-3 py-2 text-[11px] text-muted-foreground">
					{message("settings:hosted_remote_private")}{" "}
					{message("settings:hosted_remote_routes_help")}
				</FrameFooter>
			</Frame>
			<Dialog
				open={removing !== null}
				onOpenChange={(open) => {
					if (!open && !busy) setRemoving(null);
				}}
			>
				<DialogPopup className="max-w-md">
					<DialogHeader>
						<DialogTitle>
							{message("settings:hosted_remote_remove")}
							{removing?.[0]?.label ? ` — ${removing[0].label}` : ""}
						</DialogTitle>
						<DialogDescription>
							{message("settings:hosted_remote_remove_help")}
						</DialogDescription>
					</DialogHeader>
					{removeFailed && (
						<p role="alert" className="text-xs text-destructive">
							{message("settings:hosted_remote_remove_failed")}
						</p>
					)}
					<DialogFooter>
						<Button
							className="h-7"
							variant="outline"
							disabled={busy}
							onClick={() => setRemoving(null)}
						>
							{message("common:cancel")}
						</Button>
						<Button
							className="h-7"
							disabled={busy}
							onClick={async () => {
								if (!removing || busy) return;
								setBusy(true);
								setRemoveFailed(false);
								const remaining: ApiEnvironmentRecord[] = [];
								for (const registration of removing) {
									try {
										await removeHostedComputer(registration.environmentId);
										forgetHostedLaptop(
											hostedAccountId(),
											registration.environmentId,
										);
									} catch {
										remaining.push(registration);
									}
								}
								refresh();
								setBusy(false);
								if (remaining.length) {
									setRemoving(remaining);
									setRemoveFailed(true);
								} else setRemoving(null);
							}}
						>
							{busy ? <Spinner /> : message("settings:hosted_remote_remove")}
						</Button>
					</DialogFooter>
				</DialogPopup>
			</Dialog>
			<Dialog open={adding} onOpenChange={setAdding}>
				<DialogPopup className="max-w-md">
					<DialogHeader>
						<DialogTitle>
							{message("settings:using_computers_card_add_computer")}
						</DialogTitle>
						<DialogDescription>
							{message("settings:hosted_remote_setup")}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							className="h-7"
							variant="outline"
							onClick={() => void openExternal("https://zuse.sh/download")}
						>
							{message("settings:hosted_remote_download")}
						</Button>
						<Button
							className="h-7"
							onClick={() => {
								refresh();
								setAdding(false);
							}}
						>
							{message("settings:hosted_remote_refresh")}
						</Button>
					</DialogFooter>
				</DialogPopup>
			</Dialog>
		</section>
	);
}

function ComputerDetails({
	computer,
	registrations,
}: {
	computer: ApiEnvironmentRecord;
	registrations: ReadonlyArray<ApiEnvironmentRecord>;
}) {
	const { message } = useMessages(["settings", "shell"]);
	const [status, setStatus] = useState<ApiEnvironmentStatus | null>(null);
	useEffect(() => {
		let active = true;
		let pending = false;
		const refresh = async () => {
			if (pending) return;
			pending = true;
			try {
				const next = await getHostedComputerStatus(computer.environmentId);
				if (active) setStatus(next);
			} catch {
				if (active) setStatus(null);
			} finally {
				pending = false;
			}
		};
		setStatus(null);
		void refresh();
		const timer = window.setInterval(() => void refresh(), 30_000);
		return () => {
			active = false;
			window.clearInterval(timer);
		};
	}, [computer]);
	const endpoints = [
		status?.endpoint,
		...(status?.endpointCandidates?.map((candidate) => candidate.endpoint) ??
			[]),
		...registrations.map((registration) => registration.endpoint),
	];
	const routes = [
		...new Map(
			endpoints.flatMap((endpoint) => {
				const route = endpoint && hostedComputerAddress(endpoint.httpBaseUrl);
				return route ? [[route.address, route] as const] : [];
			}),
		).values(),
	];
	return (
		<div className="min-w-0 flex-1 space-y-1">
			<div className="flex items-center gap-2">
				<span className="truncate">
					{computer.label || message("shell:hosted_computer")}
				</span>
				<span className="shrink-0 text-[11px] text-muted-foreground">
					{message(
						status?.status === "online"
							? "settings:hosted_remote_online"
							: status?.status === "offline"
								? "settings:hosted_remote_offline"
								: "settings:hosted_remote_unknown",
					)}
				</span>
			</div>
			{routes.map((route) => (
				<div
					key={route.address}
					className="truncate text-[11px] text-muted-foreground"
					title={route.address}
				>
					{message(
						route.kind === "localhost"
							? "settings:hosted_remote_localhost"
							: route.kind === "tailscale"
								? "settings:access_methods_card_tailscale"
								: route.kind === "lan"
									? "settings:hosted_remote_lan"
									: "settings:hosted_remote_address",
					)}
					: {route.address}
				</div>
			))}
			{computer.lastHeartbeat != null && (
				<p className="text-[11px] text-muted-foreground">
					{message("settings:hosted_remote_last_seen", {
						date: formatDate(computer.lastHeartbeat, {
							dateStyle: "medium",
							timeStyle: "short",
						}),
					})}
				</p>
			)}
		</div>
	);
}
