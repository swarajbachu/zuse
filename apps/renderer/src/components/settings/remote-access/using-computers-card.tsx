import { MonitorCog, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import {
	type EnvironmentCatalogEntry,
	useEnvironmentCatalogStore,
} from "../../../store/environment-catalog.ts";
import {
	AddComputerDialogHost,
	openAddComputerDialog,
	relayStatusText,
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
	if (entry.connectionKind === "relay") {
		return `Zuse account · ${relayStatusText(entry)}`;
	}
	if (entry.connectionKind === "tailnet") {
		return `Tailscale · ${relayStatusText(entry)}`;
	}
	return `${entry.target?.hostname ?? "SSH"} · ${relayStatusText(entry)}`;
};

/** Compact summary of computers available in the unified sidebar. */
export function UsingComputersCard() {
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
					title="Computers"
					tooltip="Projects and chats from connected computers stay in the same sidebar."
					action={
						<Button size="sm" onClick={() => openAddComputerDialog()}>
							<Plus aria-hidden />
							Add computer
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
											Retry
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
								<p className="text-xs font-medium">No other computers yet</p>
								<p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
									Signed-in computers appear automatically, or you can add one.
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
							Removing a computer does not delete its remote data.
						</p>
						<Button
							size="xs"
							variant="ghost"
							onClick={() => openAddComputerDialog({ view: "manage" })}
						>
							Manage
						</Button>
					</FrameFooter>
				) : null}
			</Frame>
			<AddComputerDialogHost />
		</>
	);
}
