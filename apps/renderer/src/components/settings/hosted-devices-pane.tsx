import "@zuse/i18n/english/settings";
import "@zuse/i18n/english/shell";
import "@zuse/i18n/english/common";
import { useMessages } from "@zuse/i18n/react";
import { Monitor, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useHostedComputers } from "../../hooks/use-hosted-computers.ts";
import { hostedAccountId } from "../../lib/hosted-connect.ts";
import { saveHostedLaptopPreference } from "../../lib/hosted-laptop-preferences.ts";
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
	const { computers, loading, failed, refresh } = useHostedComputers();
	const [adding, setAdding] = useState(false);
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
							<span className="min-w-0 flex-1 truncate">
								{computer.label || message("shell:hosted_computer")}
							</span>
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
					{message("settings:hosted_remote_private")}
				</FrameFooter>
			</Frame>
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
