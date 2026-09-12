import "@zuse/i18n/english/settings";
import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { MonitorCog, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import {
	type EnvironmentCatalogEntry,
	useEnvironmentCatalogStore,
} from "../../../store/environment-catalog.ts";
import {
	AddComputerDialogHost,
	apiStatusText,
	openAddComputerDialog,
	StatusDot,
} from "../../add-computer-dialog.tsx";
import { Button } from "../../ui/button.tsx";
import { Card } from "../../ui/card.tsx";
import { Frame, FrameFooter } from "../../ui/frame.tsx";
import { RemoteAccessSectionHeader } from "./section-header.tsx";

const errorText = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const connectionDescription = (entry: EnvironmentCatalogEntry): string => {
	if (entry.error != null) return entry.error;
	if (entry.connectionKind === "api") {
		return `Zuse account · ${apiStatusText(entry)}`;
	}
	if (entry.connectionKind === "tailnet") {
		return `Tailscale · ${apiStatusText(entry)}`;
	}
	return `${entry.target?.hostname ?? "SSH"} · ${apiStatusText(entry)}`;
};

/** Compact summary of computers available in the unified sidebar. */
export function UsingComputersCard() {
	const { message: uiMessage } = useUiMessages(["common", "settings"]);

	const entries = useEnvironmentCatalogStore((state) => state.entries);
	const initialize = useEnvironmentCatalogStore((state) => state.initialize);
	const retry = useEnvironmentCatalogStore((state) => state.retry);
	const retryEnvironment = useEnvironmentCatalogStore(
		(state) => state.retryEnvironment,
	);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void initialize().catch((cause) => setError(errorText(cause)));
	}, [initialize]);

	const computers = entries.filter((entry) => entry.connectionKind !== "local");

	const retryEntry = (entry: EnvironmentCatalogEntry): void => {
		setError(null);
		const operation =
			entry.profileId === null
				? retryEnvironment(entry.environmentId)
				: retry(entry.profileId);
		void operation.catch((cause) => setError(errorText(cause)));
	};

	return (
		<>
			<Frame>
				<RemoteAccessSectionHeader
					title={uiMessage("settings:using_computers_card_computers")}
					tooltip={uiMessage(
						"settings:using_computers_card_projects_and_chats_from_connected_computers_stay_in_the_same_sidebar",
					)}
					action={
						<Button size="sm" onClick={() => openAddComputerDialog()}>
							<Plus aria-hidden />
							{uiMessage("settings:using_computers_card_add_computer")}
						</Button>
					}
				/>
				<Card className="overflow-hidden">
					{computers.length > 0 ? (
						<div className="flex flex-col divide-y divide-border/40">
							{computers.map((entry) => (
								<div
									key={`${entry.connectionKind}:${entry.environmentId}`}
									className="flex min-h-12 items-center gap-2.5 px-3 py-2"
								>
									<StatusDot status={entry.status} />
									<div className="min-w-0 flex-1">
										<p className="truncate text-xs font-medium">
											{entry.label}
										</p>
										<p className="truncate text-[11px] text-muted-foreground">
											{connectionDescription(entry)}
										</p>
									</div>
									{entry.status === "error" || entry.status === "offline" ? (
										<Button
											size="xs"
											variant="outline"
											onClick={() => retryEntry(entry)}
										>
											{uiMessage("common:retry")}
										</Button>
									) : null}
								</div>
							))}
						</div>
					) : (
						<div className="flex min-h-20 items-center gap-3 px-3 py-3">
							<div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
								<MonitorCog className="size-4" aria-hidden />
							</div>
							<div className="min-w-0">
								<p className="text-xs font-medium">
									{uiMessage(
										"settings:using_computers_card_no_other_computers_yet",
									)}
								</p>
								<p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
									{uiMessage("settings:using_computers_card_add_computer_help")}
								</p>
							</div>
						</div>
					)}
					{error !== null ? (
						<p
							role="alert"
							className="border-t border-border/40 px-3 py-2 text-[11px] text-destructive"
						>
							{error}
						</p>
					) : null}
				</Card>
				{computers.length > 0 ? (
					<FrameFooter className="flex items-center justify-between gap-2 px-2 py-1.5">
						<p className="text-[11px] text-muted-foreground">
							{uiMessage(
								"settings:using_computers_card_removing_a_computer_does_not_delete_its_remote_data",
							)}
						</p>
						<Button
							size="xs"
							variant="ghost"
							onClick={() => openAddComputerDialog({ view: "manage" })}
						>
							{uiMessage("settings:using_computers_card_manage")}
						</Button>
					</FrameFooter>
				) : null}
			</Frame>
			<AddComputerDialogHost />
		</>
	);
}
