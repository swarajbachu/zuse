import type { LinearConnection } from "@zuse/contracts";
import { Effect } from "effect";
import { Info } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "~/lib/error-message.ts";
import { getRpcClient } from "~/lib/rpc-client.ts";
import { Button } from "../ui/button.tsx";
import { Card } from "../ui/card.tsx";
import { Frame, FrameHeader, FrameTitle } from "../ui/frame.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip.tsx";

export function LinearIntegrationsPane() {
	const [connections, setConnections] =
		useState<ReadonlyArray<LinearConnection> | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const client = await getRpcClient();
			setConnections(
				await Effect.runPromise(client["linear.listConnections"]({})),
			);
			setError(null);
		} catch (cause) {
			setConnections([]);
			setError(errorMessage(cause, "Could not load connected workspaces."));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const connect = async () => {
		if (busy !== null) return;
		setBusy("connect");
		setError(null);
		try {
			const client = await getRpcClient();
			await Effect.runPromise(client["linear.connect"]({}));
			await load();
		} catch (cause) {
			setError(errorMessage(cause, "Could not connect the workspace."));
		} finally {
			setBusy(null);
		}
	};

	const disconnect = async (connection: LinearConnection) => {
		if (
			!window.confirm(
				`Disconnect ${connection.workspaceName}? Existing local ticket context will remain.`,
			)
		)
			return;
		setBusy(connection.workspaceId);
		setError(null);
		try {
			const client = await getRpcClient();
			await Effect.runPromise(
				client["linear.disconnect"]({ workspaceId: connection.workspaceId }),
			);
			await load();
		} catch (cause) {
			setError(errorMessage(cause, "Could not disconnect the workspace."));
		} finally {
			setBusy(null);
		}
	};
	return (
		<Frame>
			<FrameHeader className="px-2 py-1.5">
				<FrameTitle className="text-[13px] font-medium">
					Integrations
				</FrameTitle>
			</FrameHeader>
			<Card className="overflow-hidden">
				<div className="flex min-h-10 items-center gap-2 border-border/50 border-b px-3 py-2">
					<div className="grid size-7 shrink-0 place-items-center rounded-md border border-border/60 bg-muted/40 text-xs font-semibold">
						L
					</div>
					<div className="flex min-w-0 flex-1 items-center gap-1.5">
						<p className="truncate text-xs font-medium">Linear</p>
						<Tooltip>
							<TooltipTrigger
								render={
									<button
										type="button"
										aria-label="About the Linear integration"
										className="text-muted-foreground/55 hover:text-muted-foreground"
									>
										<Info className="size-3.5" />
									</button>
								}
							/>
							<TooltipPopup className="max-w-64">
								Select tickets when creating a chat. Ticket details, comments,
								and images are copied into the session workspace.
							</TooltipPopup>
						</Tooltip>
					</div>
					<Button
						type="button"
						size="sm"
						onClick={() => void connect()}
						disabled={busy !== null}
						loading={busy === "connect"}
					>
						{connections !== null && connections.length > 0
							? "Add workspace"
							: "Connect"}
					</Button>
				</div>
				{error !== null && (
					<p
						role="alert"
						className="border-border/60 border-b px-3 py-2 text-[11px] text-destructive"
					>
						{error}
					</p>
				)}

				{connections === null ? (
					<div className="grid min-h-16 place-items-center">
						<Spinner className="size-4 text-muted-foreground" />
					</div>
				) : connections.length === 0 ? (
					<div className="px-3 py-4 text-center">
						<p className="text-[11px] text-muted-foreground">
							No Linear workspaces connected yet.
						</p>
					</div>
				) : (
					<div className="divide-y divide-border/60">
						{connections.map((connection) => (
							<div
								key={connection.workspaceId}
								className="flex items-center justify-between gap-3 px-3 py-2.5"
							>
								<div className="min-w-0">
									<p className="truncate text-xs font-medium">
										{connection.workspaceName}
									</p>
									<p className="truncate text-[11px] text-muted-foreground">
										{connection.viewerName} · {connection.viewerEmail}
									</p>
									{connection.status === "reauthRequired" && (
										<p className="mt-1 text-xs text-destructive">
											Authorization expired. Reconnect this workspace.
										</p>
									)}
								</div>
								<div className="flex items-center gap-2">
									{connection.status === "reauthRequired" && (
										<Button
											type="button"
											size="sm"
											disabled={busy !== null}
											loading={busy === "connect"}
											onClick={() => void connect()}
										>
											Reconnect
										</Button>
									)}
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={busy !== null}
										loading={busy === connection.workspaceId}
										onClick={() => void disconnect(connection)}
									>
										Disconnect
									</Button>
								</div>
							</div>
						))}
					</div>
				)}
			</Card>
		</Frame>
	);
}
